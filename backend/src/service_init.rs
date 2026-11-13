//! Entware startup registration. Do not overwrite an existing custom port or an
//! explicitly disabled service when the daemon is started manually.
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::{fs, io};

const INIT_LOG: &str = "printf '[INIT] action=%s date=%s\\n' \"${1:-start}\" \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\" >> /opt/var/log/xkeen-ui.log 2>/dev/null || :";

pub fn script(port: u16) -> String {
    format!(
        "#!/bin/sh\n\nENABLED=yes\nPROCS=xkeen-ui\nARGS=\"-p {port}\"\nPREARGS=\"\"\nDESC=\"$PROCS\"\nPATH=/opt/sbin:/opt/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n\n{INIT_LOG}\n. /opt/etc/init.d/rc.func\n"
    )
}

pub fn create(path: &Path, port: u16) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    crate::fsutil::write_atomic_sync(path, script(port).as_bytes(), 0o755)?;
    let mode = fs::metadata(path)?.permissions().mode();
    fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o111))
}

pub fn ensure(path: &Path, port: u16) -> io::Result<bool> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            create(path, port)?;
            return Ok(true);
        }
        Err(error) => return Err(error),
    };
    let mode = fs::metadata(path)?.permissions().mode();
    let mut repaired = content
        .lines()
        .map(|line| {
            if line == "PROCS=/opt/sbin/xkeen-ui" {
                "PROCS=xkeen-ui"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + if content.ends_with('\n') { "\n" } else { "" };
    if repaired.lines().any(|line| line == "PROCS=xkeen-ui") && !repaired.contains("[INIT] action=") {
        repaired = repaired.replace(
            ". /opt/etc/init.d/rc.func",
            &format!("{INIT_LOG}\n. /opt/etc/init.d/rc.func"),
        );
    }
    let changed = repaired != content || mode & 0o111 != 0o111;
    if repaired != content {
        crate::fsutil::write_atomic_sync(path, repaired.as_bytes(), mode & 0o777)?;
    }
    if mode & 0o111 != 0o111 {
        fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o111))?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recreates_missing_startup_and_repairs_permissions_without_resetting_user_settings() {
        let dir = std::env::temp_dir().join(format!("xkeen-ui-init-{}", uuid::Uuid::new_v4()));
        let path = dir.join("S99xkeen-ui");
        assert!(ensure(&path, 1888).unwrap());
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("ENABLED=yes\n"));
        assert!(content.contains(INIT_LOG));
        assert!(content.contains("ARGS=\"-p 1888\""));
        assert!(!ensure(&path, 1000).unwrap());
        fs::write(
            &path,
            content
                .replace("ENABLED=yes", "ENABLED=no")
                .replace("PROCS=xkeen-ui", "PROCS=/opt/sbin/xkeen-ui"),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(ensure(&path, 1000).unwrap());
        let updated = fs::read_to_string(&path).unwrap();
        assert!(updated.contains("ENABLED=no"));
        assert!(updated.contains("ARGS=\"-p 1888\""));
        assert!(updated.contains("PROCS=xkeen-ui\n"));
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o755);
        fs::remove_dir_all(dir).unwrap();
    }
}
