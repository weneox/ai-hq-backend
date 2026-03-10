import crypto from "crypto";
import readline from "readline";

function askHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const onData = (char) => {
      char = String(char);
      switch (char) {
        case "\n":
        case "\r":
        case "\u0004":
          process.stdout.write("\n");
          break;
        default:
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(query + "*".repeat(rl.line.length));
          break;
      }
    };

    process.stdin.on("data", onData);

    rl.question(query, (value) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      resolve(String(value || ""));
    });
  });
}

function makeAdminPasscodeHash(passcode) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(passcode || ""), salt, 64);
  return `s2:${salt.toString("hex")}:${hash.toString("hex")}`;
}

const pass1 = await askHidden("Admin passcode: ");
const pass2 = await askHidden("Repeat passcode: ");

if (!pass1 || !pass2) {
  console.error("Passcode bos ola bilmez.");
  process.exit(1);
}

if (pass1 !== pass2) {
  console.error("Passcode'lar eyni deyil.");
  process.exit(1);
}

const out = makeAdminPasscodeHash(pass1);

console.log("\nADMIN_PANEL_PASSCODE_HASH=");
console.log(out);
console.log("\nBunu Railway env-e yapisdir.");