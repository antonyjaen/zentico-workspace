// Renders the source images @capacitor/assets needs from the Z logo (run: node assets/make-assets.mjs).
import sharp from "sharp";
import { fileURLToPath } from "node:url";
const Z = (stroke) => `<path d="M10 10.5h12l-12 11h12" fill="none" stroke="${stroke}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
const svg = (body, size, vb = "0 0 32 32") => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${vb}">${body}</svg>`);
const out = (name, buf) => sharp(buf).png().toFile(fileURLToPath(new URL(name, import.meta.url)));
// Full-bleed square: stores and iOS round the corners themselves.
await out("icon-only.png", svg(`<rect width="32" height="32" fill="#0a0a0a"/>${Z("#fff")}`, 1024));
// Adaptive icon: Z inside the 66% safe zone on transparent, solid background layer.
await out("icon-foreground.png", svg(Z("#fff"), 1024, "-8 -8 48 48"));
await out("icon-background.png", svg(`<rect width="32" height="32" fill="#0a0a0a"/>`, 1024));
// Splash: the Z centered on the brand background.
const splash = svg(`<rect x="-100" y="-100" width="232" height="232" fill="#0a0a0a"/>${Z("#fff")}`, 2732, "-100 -100 232 232");
await out("splash.png", splash);
await out("splash-dark.png", splash);
