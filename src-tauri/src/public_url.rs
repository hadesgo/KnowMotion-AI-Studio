use reqwest::{redirect::Policy, Client, Url};
use std::{
    collections::HashSet,
    fmt,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs},
    time::Duration,
};

const MAX_URL_CHARS: usize = 16 * 1024;
const MAX_RESOLVED_ADDRESSES: usize = 16;
const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const USER_AGENT: &str = "KnowMotion-AI-Studio/0.1";

#[derive(Debug, Clone, Copy)]
pub(crate) struct PublicHttpPolicy {
    pub max_bytes: usize,
    pub max_redirects: usize,
    pub timeout: Duration,
    pub allowed_content_types: &'static [&'static str],
}

#[derive(Debug)]
pub(crate) enum PublicUrlError {
    InvalidUrl,
    UnsupportedScheme,
    CredentialsNotAllowed,
    InvalidHost,
    PrivateHost,
    DnsFailure(String),
    NoResolvedAddresses,
    DisallowedAddress(IpAddr),
    RedirectMissingLocation,
    RedirectLimit(usize),
    RedirectLoop,
    HttpsDowngrade,
    ResponseTooLarge(usize),
    UnsupportedContentType,
    HttpStatus(u16),
    NetworkTimeout,
    NetworkFailure,
}

impl fmt::Display for PublicUrlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUrl => write!(formatter, "URL syntax is invalid"),
            Self::UnsupportedScheme => write!(formatter, "Only HTTP and HTTPS URLs are allowed"),
            Self::CredentialsNotAllowed => {
                write!(
                    formatter,
                    "URLs containing usernames or passwords are not allowed"
                )
            }
            Self::InvalidHost => write!(formatter, "URL host is invalid or not public"),
            Self::PrivateHost => write!(formatter, "URL resolves to a local or private host"),
            Self::DnsFailure(host) => write!(formatter, "DNS resolution failed for {host}"),
            Self::NoResolvedAddresses => write!(formatter, "URL host returned no IP addresses"),
            Self::DisallowedAddress(address) => write!(
                formatter,
                "URL resolves to a disallowed non-public address: {address}"
            ),
            Self::RedirectMissingLocation => {
                write!(
                    formatter,
                    "Redirect response did not contain a valid Location header"
                )
            }
            Self::RedirectLimit(limit) => {
                write!(formatter, "Redirect limit of {limit} hops was exceeded")
            }
            Self::RedirectLoop => write!(formatter, "Redirect loop detected"),
            Self::HttpsDowngrade => {
                write!(formatter, "HTTPS to HTTP redirect downgrade is not allowed")
            }
            Self::ResponseTooLarge(limit) => {
                write!(formatter, "Response exceeds the {limit} byte limit")
            }
            Self::UnsupportedContentType => {
                write!(formatter, "Remote response has an unsupported Content-Type")
            }
            Self::HttpStatus(status) => write!(formatter, "Remote server returned HTTP {status}"),
            Self::NetworkTimeout => write!(formatter, "Remote request timed out"),
            Self::NetworkFailure => write!(formatter, "Remote network request failed"),
        }
    }
}

impl std::error::Error for PublicUrlError {}

#[derive(Debug)]
pub(crate) struct PublicHttpResponse {
    pub bytes: Vec<u8>,
    pub final_url: Url,
    pub redirects: usize,
}

struct ResolvedTarget {
    url: Url,
    pinned_domain: Option<String>,
    addresses: Vec<SocketAddr>,
}

pub(crate) async fn fetch_public_http(
    raw_url: &str,
    policy: PublicHttpPolicy,
) -> Result<PublicHttpResponse, PublicUrlError> {
    let initial = normalize_public_url(raw_url, None)?;
    let mut current = initial;
    let mut visited = HashSet::new();
    visited.insert(redirect_key(&current));

    for redirects in 0..=policy.max_redirects {
        let target = resolve_public_target(current).await?;
        let client = target.client(policy.timeout)?;
        let mut request = client.get(target.url.clone());
        if !policy.allowed_content_types.is_empty() {
            request = request.header(
                reqwest::header::ACCEPT,
                policy.allowed_content_types.join(", "),
            );
        }
        let response = request.send().await.map_err(map_reqwest_error)?;
        let status = response.status();
        if matches!(status.as_u16(), 300 | 301 | 302 | 303 | 307 | 308) {
            if redirects == policy.max_redirects {
                return Err(PublicUrlError::RedirectLimit(policy.max_redirects));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or(PublicUrlError::RedirectMissingLocation)?;
            let next = redirect_target(&target.url, location)?;
            if !visited.insert(redirect_key(&next)) {
                return Err(PublicUrlError::RedirectLoop);
            }
            current = next;
            continue;
        }
        if !status.is_success() {
            return Err(PublicUrlError::HttpStatus(status.as_u16()));
        }
        if !policy.allowed_content_types.is_empty()
            && !response_content_type_allowed(&response, policy.allowed_content_types)
        {
            return Err(PublicUrlError::UnsupportedContentType);
        }
        if response
            .content_length()
            .is_some_and(|length| length > policy.max_bytes as u64)
        {
            return Err(PublicUrlError::ResponseTooLarge(policy.max_bytes));
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(map_reqwest_error)? {
            if bytes.len().saturating_add(chunk.len()) > policy.max_bytes {
                return Err(PublicUrlError::ResponseTooLarge(policy.max_bytes));
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(PublicHttpResponse {
            bytes,
            final_url: target.url,
            redirects,
        });
    }
    Err(PublicUrlError::RedirectLimit(policy.max_redirects))
}

impl ResolvedTarget {
    fn client(&self, timeout: Duration) -> Result<Client, PublicUrlError> {
        let mut builder = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(timeout)
            .redirect(Policy::none())
            .no_proxy()
            .user_agent(USER_AGENT);
        if let Some(domain) = self.pinned_domain.as_ref() {
            builder = builder.resolve_to_addrs(domain, &self.addresses);
        }
        builder.build().map_err(|_| PublicUrlError::NetworkFailure)
    }
}

fn normalize_public_url(raw_url: &str, parent: Option<&Url>) -> Result<Url, PublicUrlError> {
    let raw_url = raw_url.trim();
    if raw_url.is_empty()
        || raw_url.contains('\\')
        || raw_url.chars().any(char::is_control)
        || raw_url.chars().count() > MAX_URL_CHARS
    {
        return Err(PublicUrlError::InvalidUrl);
    }
    let parsed = if let Ok(parsed) = Url::parse(raw_url) {
        parsed
    } else if let Some(parent) = parent {
        parent
            .join(raw_url)
            .map_err(|_| PublicUrlError::InvalidUrl)?
    } else {
        return Err(PublicUrlError::InvalidUrl);
    };
    normalize_parsed_url(parsed)
}

fn normalize_parsed_url(mut url: Url) -> Result<Url, PublicUrlError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(PublicUrlError::UnsupportedScheme);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(PublicUrlError::CredentialsNotAllowed);
    }
    if url.port() == Some(0) {
        return Err(PublicUrlError::InvalidHost);
    }
    url.set_fragment(None);

    let raw_host = url
        .host_str()
        .ok_or(PublicUrlError::InvalidHost)?
        .to_string();
    let normalized_host = raw_host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.');
    if normalized_host.is_empty() || normalized_host.contains('%') {
        return Err(PublicUrlError::InvalidHost);
    }
    if let Ok(address) = normalized_host.parse::<IpAddr>() {
        if is_disallowed_ip(address) {
            return Err(PublicUrlError::PrivateHost);
        }
    } else {
        if normalized_host != raw_host {
            url.set_host(Some(normalized_host))
                .map_err(|_| PublicUrlError::InvalidHost)?;
        }
        if !valid_public_domain(normalized_host) {
            return Err(PublicUrlError::InvalidHost);
        }
    }
    Ok(url)
}

fn valid_public_domain(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    if host.len() > 253 || host.parse::<IpAddr>().is_ok() {
        return false;
    }
    let labels = host.split('.').collect::<Vec<_>>();
    if labels.len() < 2
        || labels.iter().any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return false;
    }
    !matches!(
        labels.last().copied(),
        Some("localhost" | "local" | "internal" | "home" | "test" | "invalid" | "example")
    ) && host != "home.arpa"
        && !host.ends_with(".home.arpa")
}

async fn resolve_public_target(url: Url) -> Result<ResolvedTarget, PublicUrlError> {
    let host = url
        .host_str()
        .ok_or(PublicUrlError::InvalidHost)?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or(PublicUrlError::InvalidHost)?;
    if let Ok(address) = host.parse::<IpAddr>() {
        if is_disallowed_ip(address) {
            return Err(PublicUrlError::PrivateHost);
        }
        return Ok(ResolvedTarget {
            url,
            pinned_domain: None,
            addresses: vec![SocketAddr::new(address, port)],
        });
    }

    let lookup_host = host.clone();
    let lookup = tokio::task::spawn_blocking(move || {
        (lookup_host.as_str(), port)
            .to_socket_addrs()
            .map(|addresses| addresses.collect::<Vec<_>>())
    });
    let resolved = tokio::time::timeout(DNS_TIMEOUT, lookup)
        .await
        .map_err(|_| PublicUrlError::DnsFailure(host.clone()))?
        .map_err(|_| PublicUrlError::DnsFailure(host.clone()))?
        .map_err(|_| PublicUrlError::DnsFailure(host.clone()))?;
    let addresses = validate_resolved_addresses(resolved)?;
    Ok(ResolvedTarget {
        url,
        pinned_domain: Some(host),
        addresses,
    })
}

fn validate_resolved_addresses(
    addresses: Vec<SocketAddr>,
) -> Result<Vec<SocketAddr>, PublicUrlError> {
    if addresses.is_empty() {
        return Err(PublicUrlError::NoResolvedAddresses);
    }
    for address in &addresses {
        if is_disallowed_ip(address.ip()) {
            return Err(PublicUrlError::DisallowedAddress(address.ip()));
        }
    }
    let mut unique = HashSet::new();
    let addresses = addresses
        .into_iter()
        .filter(|address| unique.insert(*address))
        .take(MAX_RESOLVED_ADDRESSES)
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        Err(PublicUrlError::NoResolvedAddresses)
    } else {
        Ok(addresses)
    }
}

fn redirect_key(url: &Url) -> String {
    let mut url = url.clone();
    url.set_fragment(None);
    url.to_string()
}

fn redirect_target(current: &Url, location: &str) -> Result<Url, PublicUrlError> {
    let next = normalize_public_url(location, Some(current))?;
    if current.scheme() == "https" && next.scheme() == "http" {
        return Err(PublicUrlError::HttpsDowngrade);
    }
    Ok(next)
}

fn response_content_type_allowed(response: &reqwest::Response, allowed: &[&str]) -> bool {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|content_type| content_type_allowed(content_type, allowed))
}

fn content_type_allowed(content_type: &str, allowed: &[&str]) -> bool {
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    allowed.iter().any(|allowed| *allowed == media_type)
}

fn map_reqwest_error(error: reqwest::Error) -> PublicUrlError {
    if error.is_timeout() {
        PublicUrlError::NetworkTimeout
    } else {
        PublicUrlError::NetworkFailure
    }
}

pub(crate) fn is_disallowed_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_disallowed_ipv4(ip),
        IpAddr::V6(ip) => is_disallowed_ipv6(ip),
    }
}

fn is_disallowed_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || (224..=239).contains(&a)
        || a >= 240
}

fn is_disallowed_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_disallowed_ipv4(mapped);
    }
    let segments = ip.segments();
    if segments[0..5].iter().all(|segment| *segment == 0) {
        if segments[5] != 0xffff {
            return true;
        }
        let embedded = Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            segments[6] as u8,
            (segments[7] >> 8) as u8,
            segments[7] as u8,
        );
        return embedded.is_unspecified() || embedded.is_loopback() || is_disallowed_ipv4(embedded);
    }
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0
        || (segments[0] == 0x0100 && segments[1..4].iter().all(|segment| *segment == 0))
        || (segments[0] == 0x2001 && segments[1] < 0x0200)
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] == 0x2002)
        || (segments[0] == 0x3fff && (segments[1] & 0xf000) == 0)
        || (segments[0] & 0xe000) != 0x2000
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(value: &str) -> Result<Url, PublicUrlError> {
        normalize_public_url(value, None)
    }

    #[test]
    fn accepts_normal_public_urls_and_removes_fragments() {
        let url = parsed("https://Example.COM./article?id=7#section").expect("public URL");
        assert_eq!(url.host_str(), Some("example.com"));
        assert_eq!(url.fragment(), None);
        assert_eq!(
            parsed("https://bücher.example.com/")
                .expect("IDN URL")
                .host_str(),
            Some("xn--bcher-kva.example.com")
        );
        assert!(parsed("http://8.8.8.8/path").is_ok());
        assert!(parsed("https://[2606:4700:4700::1111]/").is_ok());
    }

    #[test]
    fn rejects_unsafe_url_forms_and_ip_encodings() {
        for value in [
            "file:///etc/passwd",
            "ftp://example.com/file",
            "http://user:secret@example.com/",
            "http://localhost/",
            "http://service/",
            "http://127.0.0.1/",
            "http://2130706433/",
            "http://0x7f000001/",
            "http://[::1]/",
            "http://example.com:0/",
            "http://example.com\\@127.0.0.1/",
            "http://example.com/\r\nHost:127.0.0.1",
        ] {
            assert!(parsed(value).is_err(), "{value} should be rejected");
        }
    }

    #[test]
    fn rejects_special_ipv4_ranges() {
        for value in [
            "0.0.0.0",
            "10.1.2.3",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.0.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(
                is_disallowed_ip(value.parse().expect("IPv4")),
                "{value} should be rejected"
            );
        }
        for value in ["1.1.1.1", "8.8.8.8", "93.184.216.34"] {
            assert!(
                !is_disallowed_ip(value.parse().expect("IPv4")),
                "{value} should be allowed"
            );
        }
    }

    #[test]
    fn rejects_special_ipv6_ranges_and_embedded_private_ipv4() {
        for value in [
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "64:ff9b::7f00:1",
            "100::1",
            "2001:db8::1",
            "2001::1",
            "2002:7f00:1::",
            "fc00::1",
            "fe80::1",
            "ff02::1",
        ] {
            assert!(
                is_disallowed_ip(value.parse().expect("IPv6")),
                "{value} should be rejected"
            );
        }
        for value in ["2001:4860:4860::8888", "2606:4700:4700::1111"] {
            assert!(
                !is_disallowed_ip(value.parse().expect("IPv6")),
                "{value} should be allowed"
            );
        }
    }

    #[test]
    fn rejects_a_dns_answer_if_any_address_is_private() {
        let mixed = vec![
            "93.184.216.34:443".parse().expect("public address"),
            "127.0.0.1:443".parse().expect("private address"),
        ];
        assert!(matches!(
            validate_resolved_addresses(mixed),
            Err(PublicUrlError::DisallowedAddress(_))
        ));
    }

    #[test]
    fn resolves_relative_redirects_and_blocks_unsafe_targets() {
        let current = parsed("https://example.com/a/b").expect("current URL");
        assert_eq!(
            redirect_target(&current, "../next?q=1")
                .expect("relative redirect")
                .as_str(),
            "https://example.com/next?q=1"
        );
        assert!(matches!(
            normalize_public_url("http://127.0.0.1/admin", Some(&current)),
            Err(PublicUrlError::PrivateHost)
        ));
        assert!(matches!(
            normalize_public_url("javascript:alert(1)", Some(&current)),
            Err(PublicUrlError::UnsupportedScheme)
        ));
        assert!(matches!(
            redirect_target(&current, "http://1.1.1.1/"),
            Err(PublicUrlError::HttpsDowngrade)
        ));
    }

    #[test]
    fn redirect_identity_removes_fragments() {
        assert_eq!(
            redirect_key(&parsed("https://example.com/a#one").expect("URL")),
            redirect_key(&parsed("https://example.com/a#two").expect("URL"))
        );
    }

    #[test]
    fn validates_content_type_media_type_and_parameters() {
        let allowed = ["text/html", "text/plain"];
        assert!(content_type_allowed("Text/HTML; charset=utf-8", &allowed));
        assert!(content_type_allowed("text/plain", &allowed));
        assert!(!content_type_allowed("application/pdf", &allowed));
        assert!(!content_type_allowed("", &allowed));
    }
}
