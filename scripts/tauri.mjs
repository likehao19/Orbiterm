import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

// Vendored OpenSSL needs native Windows Perl, not Git's MSYS Perl.
// Keep this environment local to the build process; do not change system PATH.
if (process.platform === "win32" && !process.env.OPENSSL_SRC_PERL) {
  const project = fileURLToPath(new URL("../", import.meta.url));
  const candidates = [
    ...((process.env.PATH || "").split(delimiter).map((path) => join(path, "perl.exe"))),
    "C:\\Strawberry\\perl\\bin\\perl.exe",
    join(project, "src-tauri", "target", "key-auth-tools", "perl", "perl", "bin", "perl.exe"),
  ];
  for (const perl of candidates) {
    try {
      execFileSync(perl, ["-MIPC::Cmd", "-e", 'exit($^O eq "MSWin32" ? 0 : 1)'], {
        stdio: "ignore", windowsHide: true, timeout: 5000,
      });
      process.env.OPENSSL_SRC_PERL = perl;
      break;
    } catch {
      // Try the next installed native Perl.
    }
  }
  if (!process.env.OPENSSL_SRC_PERL && ["dev", "build"].includes(process.argv[2])) {
    console.error("编译 SSH 加密后端需要 Strawberry Perl，请安装后加入 PATH，或设置 OPENSSL_SRC_PERL 为 perl.exe 路径。");
    process.exit(1);
  }
}

await import("@tauri-apps/cli/tauri.js");
