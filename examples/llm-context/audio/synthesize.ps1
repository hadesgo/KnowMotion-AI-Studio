param([string]$TextPath,[string]$OutputPath,[string]$VoiceName,[int]$Rate)
Add-Type -AssemblyName System.Speech
$text = Get-Content -Raw -LiteralPath $TextPath
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -eq $VoiceName -and $_.Enabled } | Select-Object -First 1
  if ($null -ne $voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }
  $synth.Rate = $Rate
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($OutputPath, $format)
  $synth.Speak($text)
} finally { $synth.Dispose() }