//! Crash-safe file replacement: write to a temp file in the same directory, fsync it,
//! then rename it over the target so readers never observe a truncated file.

use std::fs::{self, File, OpenOptions, Permissions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Mode for new files that may hold credentials (proxy configs, keys).
pub const PRIVATE_MODE: u32 = 0o600;
/// Mode for new regular files (matches the usual `0666 & ~022`).
pub const DEFAULT_MODE: u32 = 0o644;

/// Writes through a symlink to its target, like a plain `fs::write` would,
/// instead of replacing the link itself with a regular file.
fn resolve_target(path: &Path) -> io::Result<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => match fs::canonicalize(path) {
            Ok(target) => Ok(target),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(path.to_path_buf()),
            Err(e) => Err(e),
        },
        _ => Ok(path.to_path_buf()),
    }
}

fn sync_dir(dir: &Path) {
    // Persist the rename itself; failure here is not fatal for the data already written.
    if let Ok(dir) = File::open(dir) {
        let _ = dir.sync_all();
    }
}

/// Creates a temp file next to `target`, fills it, fsyncs it and renames it over `target`.
fn stage_and_rename(target: &Path, mode: u32, fill: impl FnOnce(&mut File) -> io::Result<()>) -> io::Result<()> {
    let parent = match target.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let tmp = parent.join(format!(".xkeen-ui-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new().create_new(true).write(true).mode(mode).open(&tmp)?;
        fill(&mut file)?;
        // `mode` above is filtered by umask; set the exact bits explicitly.
        file.set_permissions(Permissions::from_mode(mode))?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, target)?;
        sync_dir(parent);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Atomically replaces `path` with `bytes`. An existing file keeps its permission bits;
/// a new one is created with `default_mode`. The parent directory must exist.
pub fn write_atomic_sync(path: &Path, bytes: &[u8], default_mode: u32) -> io::Result<()> {
    let path = resolve_target(path)?;
    let mode = fs::metadata(&path).map_or(default_mode, |m| m.permissions().mode() & 0o777);
    stage_and_rename(&path, mode, |file| file.write_all(bytes))
}

/// Atomically replaces `target` with the file at `source` (consumed) and sets `mode`.
/// A plain rename when both are on one filesystem, otherwise a staged copy next to `target`.
pub fn replace_with_file_sync(source: &Path, target: &Path, mode: u32) -> io::Result<()> {
    fs::set_permissions(source, Permissions::from_mode(mode))?;
    if fs::rename(source, target).is_ok() {
        if let Some(parent) = target.parent() {
            sync_dir(parent);
        }
        return Ok(());
    }
    stage_and_rename(target, mode, |file| {
        io::copy(&mut File::open(source)?, file).map(|_| ())
    })?;
    let _ = fs::remove_file(source);
    Ok(())
}

/// Async wrapper around [`write_atomic_sync`] that runs on the blocking pool.
pub async fn write_atomic(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>, default_mode: u32) -> io::Result<()> {
    let path = path.as_ref().to_path_buf();
    let bytes = bytes.as_ref().to_vec();
    tokio::task::spawn_blocking(move || write_atomic_sync(&path, &bytes, default_mode))
        .await
        .map_err(io::Error::other)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_content_and_keeps_mode() {
        let dir = std::env::temp_dir().join(format!("xkeen-ui-fsutil-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");

        write_atomic_sync(&path, b"one", PRIVATE_MODE).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "one");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);

        fs::set_permissions(&path, Permissions::from_mode(0o640)).unwrap();
        write_atomic_sync(&path, b"two", PRIVATE_MODE).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);

        let link = dir.join("link.json");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        write_atomic_sync(&link, b"three", PRIVATE_MODE).unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&path).unwrap(), "three");

        let leftovers = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replaces_file_from_source() {
        let dir = std::env::temp_dir().join(format!("xkeen-ui-fsutil-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let (source, target) = (dir.join("new.bin"), dir.join("app"));
        fs::write(&target, "old").unwrap();
        fs::write(&source, "new").unwrap();

        replace_with_file_sync(&source, &target, 0o755).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o755);
        assert!(!source.exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
