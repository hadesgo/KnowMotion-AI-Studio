/* global process */
// Some managed Windows sessions deny the account lookup used by tsx's cache
// path discovery. Node tests do not need the real effective UID, so provide
// the Unix-compatible value that tsx already checks before calling os.userInfo.
if (typeof process.geteuid !== "function") {
  Object.defineProperty(process, "geteuid", {
    configurable: true,
    value: () => 1000,
  });
}
