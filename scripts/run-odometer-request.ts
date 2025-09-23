import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import app from "../src/server/app.js";

async function run(sampleName: string) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  const samplePath = path.resolve("samples", "odometer", sampleName);
  const fileBuffer = await readFile(samplePath);
  const form = new FormData();
  form.append("file", new File([fileBuffer], sampleName, { type: "image/jpeg" }));

  const start = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/ocr/odometer`, {
    method: "POST",
    body: form,
  });
  const durationMs = Date.now() - start;
  const json = await response.json();

  console.log(JSON.stringify({ sample: sampleName, status: response.status, durationMs, result: json }, null, 2));

  server.close();
}

const samples = ["actual_odo_1.jpg", "actual_odo_2.jpg"];
for (const name of samples) {
  await run(name);
}
