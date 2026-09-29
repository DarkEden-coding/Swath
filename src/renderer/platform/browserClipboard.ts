import type { TerminalClipboardPayload } from "../../shared/types";

/** Read the viewing device's clipboard, never the remote server's OS clipboard. */
export async function readBrowserClipboard(): Promise<TerminalClipboardPayload> {
  const clipboard = navigator.clipboard;
  if (!clipboard) throw new Error("Clipboard access requires HTTPS and browser permission.");
  if (!clipboard.read) return { text: await clipboard.readText(), hasImage: false };
  const items = await clipboard.read();
  let text = "";
  let image: Blob | undefined;
  for (const item of items) {
    if (!text && item.types.includes("text/plain"))
      text = await (await item.getType("text/plain")).text();
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (!image && imageType) image = await item.getType(imageType);
  }
  if (!image) return { text, hasImage: false };
  const bitmap = await createImageBitmap(image);
  try {
    if (bitmap.width * bitmap.height > 16_777_216)
      throw new Error("Clipboard image exceeds the 16-megapixel limit.");
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Browser cannot decode clipboard images.");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let binary = "";
    for (let offset = 0; offset < pixels.length; offset += 8192) {
      binary += String.fromCharCode(...pixels.subarray(offset, offset + 8192));
    }
    return {
      text,
      hasImage: true,
      imageData: btoa(binary),
      imageWidth: bitmap.width,
      imageHeight: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}
