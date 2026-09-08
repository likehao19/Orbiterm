use base64::{engine::general_purpose::STANDARD, Engine};
use ssh2::{Error, ErrorCode, Session};
use std::path::Path;

pub(crate) fn configure_host_key_preference(session: &Session) -> Result<(), String> {
    // WinCNG negotiated RSA host keys. Preserve existing Windows fingerprints
    // when enabling OpenSSL; this does not restrict user authentication keys.
    #[cfg(windows)]
    session.method_pref(
        ssh2::MethodType::HostKey,
        "rsa-sha2-512,rsa-sha2-256,rsa-sha2-512-cert-v01@openssh.com,rsa-sha2-256-cert-v01@openssh.com,ssh-rsa,ssh-rsa-cert-v01@openssh.com,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,ssh-ed25519,ssh-dss",
    ).map_err(|error| format!("配置主机密钥算法失败：{error}"))?;
    #[cfg(not(windows))]
    let _ = session;
    Ok(())
}

pub(crate) fn authenticate(
    session: &Session,
    username: &str,
    path: &Path,
    passphrase: Option<&str>,
) -> Result<(), String> {
    // Rust uses Windows Unicode paths; libssh2's file API uses narrow fopen paths.
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("无法读取私钥文件：{error}"))?;
    let text = text
        .trim_start_matches('\u{feff}')
        .trim()
        .replace("\r\n", "\n")
        + "\n";
    let encrypted = is_encrypted(&text)?;
    let passphrase = passphrase.filter(|value| !value.is_empty());
    if encrypted && passphrase.is_none() {
        return Err("该私钥已加密，请填写私钥口令（不是服务器登录密码）".to_string());
    }
    if passphrase.is_some_and(|value| value.contains('\0')) {
        return Err("私钥口令不能包含空字符".to_string());
    }
    session
        .userauth_pubkey_memory(username, None, &text, passphrase)
        .map_err(|error| authentication_error(&error, encrypted))
}

fn is_encrypted(text: &str) -> Result<bool, String> {
    let header = text.lines().next().unwrap_or_default();
    if header.starts_with("PuTTY-User-Key-File-") {
        return Err("检测到 PuTTY PPK 私钥，当前需在 PuTTYgen 中导出为 OpenSSH 私钥后使用（仅修改扩展名无效）".to_string());
    }
    if header.starts_with("ssh-")
        || header.starts_with("ecdsa-")
        || header.starts_with("sk-")
        || header.contains("PUBLIC KEY")
    {
        return Err("所选文件是公钥，请选择对应的私钥文件（通常不带 .pub 扩展名）".to_string());
    }
    if !matches!(
        header,
        "-----BEGIN OPENSSH PRIVATE KEY-----"
            | "-----BEGIN RSA PRIVATE KEY-----"
            | "-----BEGIN EC PRIVATE KEY-----"
            | "-----BEGIN DSA PRIVATE KEY-----"
            | "-----BEGIN PRIVATE KEY-----"
            | "-----BEGIN ENCRYPTED PRIVATE KEY-----"
    ) {
        return Err("无法识别私钥格式，请选择完整的 OpenSSH 或 PEM 私钥文件".to_string());
    }
    let footer = header.replace("BEGIN", "END");
    if !text.lines().any(|line| line == footer) || text.contains('\0') {
        return Err("私钥文件不完整或已损坏".to_string());
    }
    if header == "-----BEGIN OPENSSH PRIVATE KEY-----" {
        // Only inspect the public envelope. Key decoding/decryption stays in libssh2.
        let body: String = text
            .lines()
            .skip(1)
            .take_while(|line| *line != footer)
            .collect();
        let data = STANDARD
            .decode(body)
            .map_err(|_| "OpenSSH 私钥编码已损坏".to_string())?;
        let envelope = data
            .strip_prefix(b"openssh-key-v1\0")
            .ok_or_else(|| "OpenSSH 私钥格式已损坏".to_string())?;
        let length = envelope
            .get(..4)
            .and_then(|bytes| bytes.try_into().ok())
            .map(u32::from_be_bytes)
            .ok_or_else(|| "OpenSSH 私钥头部不完整".to_string())? as usize;
        let cipher = envelope
            .get(4..)
            .and_then(|bytes| bytes.get(..length))
            .filter(|cipher| !cipher.is_empty())
            .ok_or_else(|| "OpenSSH 私钥头部不完整".to_string())?;
        return Ok(cipher != b"none");
    }
    Ok(header == "-----BEGIN ENCRYPTED PRIVATE KEY-----"
        || text.lines().any(|line| line == "Proc-Type: 4,ENCRYPTED"))
}

fn authentication_error(error: &Error, encrypted: bool) -> String {
    let hint = match error.code() {
        ErrorCode::Session(-18 | -19) => {
            "服务器拒绝此密钥，请检查登录用户名、服务器 authorized_keys 和公钥认证策略"
        }
        ErrorCode::Session(-48 | -16 | -12 | -1) if encrypted => {
            "无法解密或解析私钥，请检查私钥口令；也可能是密钥损坏或加密格式不受支持"
        }
        ErrorCode::Session(-48 | -16 | -12 | -1) => {
            "无法解析私钥，文件可能已损坏或使用了不受支持的密钥格式"
        }
        _ => "SSH 私钥认证未完成",
    };
    format!("私钥认证失败：{hint}（{error}）")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn openssh_envelope(cipher: &[u8]) -> String {
        let mut data = b"openssh-key-v1\0".to_vec();
        data.extend_from_slice(&(cipher.len() as u32).to_be_bytes());
        data.extend_from_slice(cipher);
        format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----\n",
            STANDARD.encode(data)
        )
    }

    #[test]
    fn detects_openssh_encryption_from_content() {
        assert!(!is_encrypted(&openssh_envelope(b"none")).unwrap());
        assert!(is_encrypted(&openssh_envelope(b"aes256-ctr")).unwrap());
    }

    #[test]
    fn recognizes_pem_encryption() {
        for kind in ["RSA", "EC", "DSA"] {
            let text = format!(
                "-----BEGIN {kind} PRIVATE KEY-----\nAA==\n-----END {kind} PRIVATE KEY-----"
            );
            assert!(!is_encrypted(&text).unwrap());
            assert!(is_encrypted(&text.replace("AA==", "Proc-Type: 4,ENCRYPTED\nAA==")).unwrap());
        }
        assert!(is_encrypted(
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAA==\n-----END ENCRYPTED PRIVATE KEY-----"
        )
        .unwrap());
    }

    #[test]
    fn rejects_public_keys_and_identifies_ppk_without_using_extensions() {
        assert!(is_encrypted("ssh-ed25519 AAAA test")
            .unwrap_err()
            .contains("公钥"));
        for version in [2, 3] {
            assert!(
                is_encrypted(&format!("PuTTY-User-Key-File-{version}: ssh-rsa"))
                    .unwrap_err()
                    .contains("PPK")
            );
        }
        assert!(is_encrypted("").is_err());
    }

    #[test]
    fn rejects_truncated_and_invalid_openssh_headers() {
        assert!(is_encrypted("-----BEGIN OPENSSH PRIVATE KEY-----\n").is_err());
        assert!(is_encrypted(&openssh_envelope(b"none").replace("b3Bl", "!!!!")).is_err());
        assert!(is_encrypted(&openssh_envelope(b"")).is_err());
    }

    #[test]
    fn distinguishes_server_rejection_from_local_key_failure() {
        let rejected = Error::from_errno(ErrorCode::Session(-18));
        let invalid = Error::from_errno(ErrorCode::Session(-48));
        assert!(authentication_error(&rejected, true).contains("服务器拒绝"));
        assert!(authentication_error(&invalid, true).contains("口令"));
        assert!(authentication_error(&invalid, false).contains("无法解析"));
    }
}
