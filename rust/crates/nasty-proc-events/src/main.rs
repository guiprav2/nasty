#![cfg(target_os = "linux")]

use std::io::{self, Write};
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, Ordering};

const AF_NETLINK: libc::c_int = 16;
const NETLINK_CONNECTOR: libc::c_int = 11;
const CN_IDX_PROC: u32 = 1;
const CN_VAL_PROC: u32 = 1;
const PROC_CN_MCAST_LISTEN: u32 = 1;
const PROC_CN_MCAST_IGNORE: u32 = 2;
const NLMSG_DONE: u16 = 3;
const PROC_EVENT_FORK: u32 = 0x0000_0001;
const PROC_EVENT_EXEC: u32 = 0x0000_0002;
const PROC_EVENT_EXIT: u32 = 0x8000_0000;

static RUNNING: AtomicBool = AtomicBool::new(true);

#[repr(C)]
struct SockAddrNl {
    family: libc::sa_family_t,
    pad: u16,
    pid: u32,
    groups: u32,
}

#[repr(C)]
struct NlMsgHdr {
    len: u32,
    kind: u16,
    flags: u16,
    seq: u32,
    pid: u32,
}

extern "C" fn stop(_: libc::c_int) {
    RUNNING.store(false, Ordering::Relaxed);
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_ne_bytes(bytes.get(offset..offset + 2)?.try_into().ok()?))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_ne_bytes(bytes.get(offset..offset + 4)?.try_into().ok()?))
}

fn send_control(fd: libc::c_int, operation: u32, pid: u32) -> io::Result<()> {
    let mut message = [0u8; size_of::<NlMsgHdr>() + 20 + 4];
    let message_len = message.len() as u32;
    message[0..4].copy_from_slice(&message_len.to_ne_bytes());
    message[4..6].copy_from_slice(&NLMSG_DONE.to_ne_bytes());
    message[12..16].copy_from_slice(&pid.to_ne_bytes());
    let connector = size_of::<NlMsgHdr>();
    message[connector..connector + 4].copy_from_slice(&CN_IDX_PROC.to_ne_bytes());
    message[connector + 4..connector + 8].copy_from_slice(&CN_VAL_PROC.to_ne_bytes());
    message[connector + 16..connector + 18].copy_from_slice(&4u16.to_ne_bytes());
    message[connector + 20..connector + 24].copy_from_slice(&operation.to_ne_bytes());

    let kernel = SockAddrNl { family: AF_NETLINK as _, pad: 0, pid: 0, groups: 0 };
    let sent = unsafe {
        libc::sendto(
            fd,
            message.as_ptr().cast(),
            message.len(),
            0,
            (&kernel as *const SockAddrNl).cast(),
            size_of::<SockAddrNl>() as _,
        )
    };
    if sent < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

fn emit_proc_event(event: &[u8]) {
    let Some(kind) = read_u32(event, 0) else { return };
    let (name, pid) = match kind {
        PROC_EVENT_FORK => {
            let (Some(child_pid), Some(child_tgid)) = (read_u32(event, 24), read_u32(event, 28)) else { return };
            if child_pid != child_tgid { return; }
            ("fork", child_tgid)
        }
        PROC_EVENT_EXEC => {
            let Some(pid) = read_u32(event, 20) else { return };
            ("exec", pid)
        }
        PROC_EVENT_EXIT => {
            let (Some(process_pid), Some(process_tgid)) = (read_u32(event, 16), read_u32(event, 20)) else { return };
            if process_pid != process_tgid { return; }
            ("exit", process_tgid)
        }
        _ => return,
    };
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{{\"type\":\"{name}\",\"pid\":{pid}}}");
    let _ = stdout.flush();
}

fn run() -> io::Result<()> {
    unsafe {
        let handler = stop as *const () as libc::sighandler_t;
        libc::signal(libc::SIGINT, handler);
        libc::signal(libc::SIGTERM, handler);
    }
    let fd = unsafe { libc::socket(AF_NETLINK, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, NETLINK_CONNECTOR) };
    if fd < 0 { return Err(io::Error::last_os_error()); }
    let local = SockAddrNl { family: AF_NETLINK as _, pad: 0, pid: unsafe { libc::getpid() as u32 }, groups: CN_IDX_PROC };
    let bound = unsafe {
        libc::bind(fd, (&local as *const SockAddrNl).cast(), size_of::<SockAddrNl>() as _)
    };
    if bound < 0 {
        let error = io::Error::last_os_error();
        unsafe { libc::close(fd); }
        return Err(error);
    }
    if let Err(error) = send_control(fd, PROC_CN_MCAST_LISTEN, local.pid) {
        unsafe { libc::close(fd); }
        return Err(error);
    }

    let mut buffer = [0u8; 8192];
    while RUNNING.load(Ordering::Relaxed) {
        let mut poll_fd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        let ready = unsafe { libc::poll(&mut poll_fd, 1, 500) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted { continue; }
            unsafe { libc::close(fd); }
            return Err(error);
        }
        if ready == 0 { continue; }
        let length = unsafe { libc::recv(fd, buffer.as_mut_ptr().cast(), buffer.len(), 0) };
        if length < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted { continue; }
            unsafe { libc::close(fd); }
            return Err(error);
        }
        let bytes = &buffer[..length as usize];
        let mut offset = 0usize;
        while offset + 16 + 20 <= bytes.len() {
            let Some(message_len) = read_u32(bytes, offset).map(|value| value as usize) else { break };
            if message_len < 36 || offset + message_len > bytes.len() { break; }
            let connector = offset + 16;
            if read_u32(bytes, connector) == Some(CN_IDX_PROC)
                && read_u32(bytes, connector + 4) == Some(CN_VAL_PROC)
                && read_u16(bytes, connector + 16).unwrap_or(0) as usize >= 40
            {
                emit_proc_event(&bytes[connector + 20..offset + message_len]);
            }
            offset += (message_len + 3) & !3;
        }
    }
    let _ = send_control(fd, PROC_CN_MCAST_IGNORE, local.pid);
    unsafe { libc::close(fd); }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("nasty-proc-events: {error}");
        std::process::exit(1);
    }
}
