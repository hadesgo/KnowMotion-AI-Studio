use std::process::Child;

#[cfg(windows)]
use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    sync::Arc,
};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::HANDLE,
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
};
#[cfg(all(test, windows))]
use windows_sys::Win32::System::JobObjects::{
    JobObjectBasicProcessIdList, QueryInformationJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
};

#[derive(Clone)]
pub(crate) struct RenderJobObject {
    #[cfg(windows)]
    handle: Arc<OwnedHandle>,
}

impl RenderJobObject {
    pub(crate) fn attach(child: &Child) -> Result<Self, String> {
        #[cfg(windows)]
        {
            unsafe {
                let raw_job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if raw_job.is_null() {
                    return Err(format!(
                        "Unable to create renderer Job Object: {}",
                        io::Error::last_os_error()
                    ));
                }
                let handle = Arc::new(OwnedHandle::from_raw_handle(raw_job as RawHandle));
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
                limits.BasicLimitInformation.ActiveProcessLimit = 64;
                if SetInformationJobObject(
                    handle.as_raw_handle() as HANDLE,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    return Err(format!(
                        "Unable to configure renderer Job Object: {}",
                        io::Error::last_os_error()
                    ));
                }
                if AssignProcessToJobObject(
                    handle.as_raw_handle() as HANDLE,
                    child.as_raw_handle() as HANDLE,
                ) == 0
                {
                    return Err(format!(
                        "Unable to assign renderer process to Job Object: {}",
                        io::Error::last_os_error()
                    ));
                }
                Ok(Self { handle })
            }
        }
        #[cfg(not(windows))]
        {
            let _ = child;
            Ok(Self {})
        }
    }

    pub(crate) fn terminate(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            if unsafe { TerminateJobObject(self.handle.as_raw_handle() as HANDLE, 1) } == 0 {
                return Err(format!(
                    "Unable to terminate renderer Job Object: {}",
                    io::Error::last_os_error()
                ));
            }
        }
        Ok(())
    }

    #[cfg(all(test, windows))]
    fn process_ids(&self) -> Result<Vec<u32>, String> {
        let mut buffer = [0_usize; 65];
        let mut returned_length = 0_u32;
        let success = unsafe {
            QueryInformationJobObject(
                self.handle.as_raw_handle() as HANDLE,
                JobObjectBasicProcessIdList,
                buffer.as_mut_ptr() as *mut std::ffi::c_void,
                std::mem::size_of_val(&buffer) as u32,
                &mut returned_length,
            )
        };
        if success == 0 {
            return Err(format!(
                "Unable to query renderer Job Object: {}",
                io::Error::last_os_error()
            ));
        }
        let count = unsafe { *(buffer.as_ptr() as *const u32).add(1) } as usize;
        let ids_offset = std::mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList);
        let ids = unsafe {
            std::slice::from_raw_parts(
                (buffer.as_ptr() as *const u8).add(ids_offset) as *const usize,
                count.min(64),
            )
        };
        Ok(ids.iter().map(|pid| *pid as u32).collect())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, STILL_ACTIVE},
        System::{
            Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };

    #[test]
    fn terminating_job_kills_descendant_process_tree() {
        let (mut parent, child_pid) = spawn_tree();
        let job = RenderJobObject::attach(&parent).expect("attach render job object");
        let child_pid = wait_for_descendant(&job, parent.id()).unwrap_or(child_pid);
        assert!(process_is_alive(child_pid), "descendant should be running");
        job.terminate().expect("terminate render job object");
        assert_process_exits(child_pid);
        let _ = parent.wait();
    }

    #[test]
    fn closing_last_job_handle_kills_descendant_process_tree() {
        let (mut parent, child_pid) = spawn_tree();
        let job = RenderJobObject::attach(&parent).expect("attach render job object");
        let child_pid = wait_for_descendant(&job, parent.id()).unwrap_or(child_pid);
        assert!(process_is_alive(child_pid), "descendant should be running");
        drop(job);
        assert_process_exits(child_pid);
        let _ = parent.wait();
    }

    fn spawn_tree() -> (Child, u32) {
        let parent = Command::new("cmd.exe")
            .args(["/D", "/C", "ping -n 60 127.0.0.1 > nul"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn process tree");
        let parent_pid = parent.id();
        (parent, parent_pid)
    }

    fn assert_process_exits(pid: u32) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while process_is_alive(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !process_is_alive(pid),
            "closing/terminating the Job Object must kill the descendant process"
        );
    }

    fn wait_for_descendant(job: &RenderJobObject, parent_pid: u32) -> Option<u32> {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(ids) = job.process_ids() {
                if let Some(pid) = ids.into_iter().find(|pid| *pid != parent_pid) {
                    return Some(pid);
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        None
    }

    fn process_is_alive(pid: u32) -> bool {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut exit_code = 0_u32;
            let success = GetExitCodeProcess(handle, &mut exit_code) != 0;
            CloseHandle(handle);
            success && exit_code == STILL_ACTIVE as u32
        }
    }
}
