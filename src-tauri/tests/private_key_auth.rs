#[path = "../src/ssh_auth.rs"]
mod ssh_auth;

use ssh2::Session;
use std::{net::TcpStream, path::PathBuf};

// Run through scripts/test-private-key-auth.py, which supplies a loopback SSH
// server and newly generated disposable keys, never real server credentials.
#[test]
#[ignore = "requires the local test server; run scripts/test-private-key-auth.py"]
fn authenticates_generated_keys() {
    let directory = PathBuf::from(std::env::var_os("ORBITERM_KEY_TEST_DIR").unwrap());
    let port: u16 = std::env::var("ORBITERM_KEY_TEST_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let host_key = std::fs::read(directory.join("host-public.bin")).unwrap();
    for kind in ["rsa", "ed25519", "ecdsa", "rsa-pem", "rsa-pkcs8"] {
        for encrypted in [false, true] {
            let filename = format!(
                "{kind}-{}.key",
                if encrypted { "encrypted" } else { "plain" }
            );
            for wrong_password in [false, true] {
                if wrong_password && !encrypted {
                    continue;
                }
                let mut session = Session::new().unwrap();
                ssh_auth::configure_host_key_preference(&session).unwrap();
                session.set_tcp_stream(TcpStream::connect(("127.0.0.1", port)).unwrap());
                session.set_timeout(5000);
                session.handshake().unwrap();
                assert_eq!(session.host_key().unwrap().0, host_key);
                let passphrase = if encrypted {
                    Some(if wrong_password {
                        "wrong"
                    } else {
                        " test 私钥口令 "
                    })
                } else {
                    None
                };
                let result = ssh_auth::authenticate(
                    &session,
                    "test",
                    &directory.join(&filename),
                    passphrase,
                );
                if wrong_password {
                    let message = result.unwrap_err();
                    assert!(message.contains("口令"), "{filename}: {message}");
                    assert!(!session.authenticated());
                } else {
                    result.unwrap_or_else(|error| panic!("{filename}: {error}"));
                    assert!(session.authenticated(), "{filename}");
                }
                println!("PASS {filename}, wrong_password={wrong_password}");
            }
        }
    }
    let session = Session::new().unwrap();
    let encrypted = directory.join("ed25519-encrypted.key");
    assert!(ssh_auth::authenticate(&session, "test", &encrypted, None)
        .unwrap_err()
        .contains("已加密"));
    assert!(
        ssh_auth::authenticate(&session, "test", &directory.join("missing"), None)
            .unwrap_err()
            .contains("无法读取")
    );
    let mut rejected = Session::new().unwrap();
    ssh_auth::configure_host_key_preference(&rejected).unwrap();
    rejected.set_tcp_stream(TcpStream::connect(("127.0.0.1", port)).unwrap());
    rejected.set_timeout(5000);
    rejected.handshake().unwrap();
    assert_eq!(rejected.host_key().unwrap().0, host_key);
    let error = ssh_auth::authenticate(
        &rejected,
        "wrong-user",
        &directory.join("ed25519-plain.key"),
        None,
    )
    .unwrap_err();
    assert!(error.contains("服务器拒绝"), "{error}");
}
