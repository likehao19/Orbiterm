"""Local-only SSH regression test. Requires Python cryptography and paramiko.

Generates disposable keys inside a temporary Unicode path, starts an SSH server
bound only to loopback, and runs the same Rust authentication helper as the app.
"""
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading

import paramiko
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, rsa


def main():
    with tempfile.TemporaryDirectory(prefix="orbiterm-私钥 测试-") as temporary:
        directory = Path(temporary)
        allowed = set()
        for kind in ("rsa", "ed25519", "ecdsa", "rsa-pem", "rsa-pkcs8"):
            if kind == "ed25519":
                key = ed25519.Ed25519PrivateKey.generate()
            elif kind == "ecdsa":
                key = ec.generate_private_key(ec.SECP256R1())
            else:
                key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            public = key.public_key().public_bytes(
                serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH
            )
            allowed.add(public.split()[1].decode())
            key_format = {
                "rsa-pem": serialization.PrivateFormat.TraditionalOpenSSL,
                "rsa-pkcs8": serialization.PrivateFormat.PKCS8,
            }.get(kind, serialization.PrivateFormat.OpenSSH)
            for encrypted in (False, True):
                encryption = (
                    serialization.BestAvailableEncryption(" test 私钥口令 ".encode("utf-8"))
                    if encrypted else serialization.NoEncryption()
                )
                data = key.private_bytes(serialization.Encoding.PEM, key_format, encryption)
                # Exercise BOM and Windows newlines without changing the key payload.
                data = b"\xef\xbb\xbf" + data.replace(b"\n", b"\r\n")
                suffix = "encrypted" if encrypted else "plain"
                (directory / f"{kind}-{suffix}.key").write_bytes(data)

        host_key = paramiko.RSAKey.generate(2048)
        alternate_host_key = paramiko.ECDSAKey.generate()
        expected_host_key = host_key if os.name == "nt" else alternate_host_key
        (directory / "host-public.bin").write_bytes(expected_host_key.asbytes())

        class Server(paramiko.ServerInterface):
            def get_allowed_auths(self, username):
                return "publickey"

            def check_auth_publickey(self, username, key):
                if username == "test" and key.get_base64() in allowed:
                    return paramiko.AUTH_SUCCESSFUL
                return paramiko.AUTH_FAILED

        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            listener.settimeout(0.2)
            stop = threading.Event()
            workers = []

            def serve_connection(connection):
                with paramiko.Transport(connection) as transport:
                    transport.add_server_key(host_key)
                    transport.add_server_key(alternate_host_key)
                    try:
                        transport.start_server(server=Server())
                        while transport.is_active() and not stop.wait(0.05):
                            pass
                    except (EOFError, paramiko.SSHException):
                        pass

            def accept_connections():
                while not stop.is_set():
                    try:
                        connection, _ = listener.accept()
                    except socket.timeout:
                        continue
                    worker = threading.Thread(target=serve_connection, args=(connection,))
                    worker.start()
                    workers.append(worker)

            server = threading.Thread(target=accept_connections)
            server.start()
            environment = os.environ.copy()
            environment["ORBITERM_KEY_TEST_DIR"] = temporary
            environment["ORBITERM_KEY_TEST_PORT"] = str(listener.getsockname()[1])
            try:
                result = subprocess.run(
                    ["cargo", "test", "--test", "private_key_auth", "--", "--ignored", "--nocapture"],
                    cwd=Path(__file__).resolve().parents[1] / "src-tauri",
                    env=environment,
                )
            finally:
                stop.set()
                server.join()
                for worker in workers:
                    worker.join()
            raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
