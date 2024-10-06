import OpenAI from "openai";
import CrunkerUntyped from "crunker";

import type { Readability as ReadabilityType } from "@mozilla/readability";
import { Readability as ReadabilityUntyped } from "./readability";

import { OPENAI_API_KEY } from "../api_keys";

const Crunker = ((CrunkerUntyped as any).default ||
  CrunkerUntyped) as typeof CrunkerUntyped;
const Readability = ReadabilityUntyped as typeof ReadabilityType;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  dangerouslyAllowBrowser: true,
});

function getDocumentHTML() {
  return new XMLSerializer().serializeToString(document);
}

async function mp3ArrayBufferToAudioBuffer(arrayBuffer: ArrayBuffer) {
  // Create a new AudioContext
  const audioContext = new AudioContext();

  try {
    // Decode the ArrayBuffer containing MP3 data into an AudioBuffer
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    return audioBuffer;
  } catch (error) {
    console.error("Error decoding audio data:", error);
    throw error;
  } finally {
    // Close the AudioContext when done
    if (audioContext.state !== "closed") {
      await audioContext.close();
    }
  }
}

chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
  const tabId = tabs[0].id;
  if (!tabId) {
    throw new Error("No tab id found");
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: getDocumentHTML,
  });

  const { result } = results[0];
  if (!result) {
    throw new Error("No result found");
  }

  // Create new document from the result.
  const parser = new DOMParser();
  const doc = parser.parseFromString(result, "text/html");

  // Run through readability.
  const { content, textContent } = new Readability(doc).parse() || {
    content: "",
    textContent: "",
  };

  if (!content || !textContent) {
    throw new Error("No content found");
  }

  // Get characters in word groups of 4096.
  const _textChunks = textContent.split(" ");
  const chunkSize = 4096;
  const mergedTextChunks: string[] = [];

  let accum = 0;
  let chunk = "";
  for (let i = 0; i < _textChunks.length; i++) {
    const word = _textChunks[i];
    if (accum + 1 + word.length > chunkSize) {
      mergedTextChunks.push(chunk);
      chunk = "";
      accum = 0;
    }
    chunk += word + " ";
    accum += word.length + 1;
  }
  if (chunk.trim()) {
    mergedTextChunks.push(chunk);
  }

  const cost = (textContent.length * 15) / 1000000;
  const generateStr = `Generate audio ($${cost.toFixed(2)})`;
  document.querySelector("#content")!.innerHTML = `
    <div id="readability">${content}</div>
    <button id="generate">${generateStr}</button>
  `;

  const generateButton = document.querySelector(
    "#generate"
  ) as HTMLButtonElement;

  generateButton.addEventListener("click", async () => {
    try {
      // Generate audio.
      generateButton.innerHTML = `Generating...`;
      const audioBuffers = await Promise.all(
        mergedTextChunks.map(async (chunk) => {
          const mp3 = await openai.audio.speech.create({
            model: "tts-1",
            voice: "alloy",
            input: chunk,
          });

          const arrayBuffer = await mp3.arrayBuffer();
          const audioBuffer = await mp3ArrayBufferToAudioBuffer(arrayBuffer);

          return audioBuffer;
        })
      );

      generateButton.innerHTML = "Merging audio...";

      const crunker = new Crunker();
      const mergedAudioBuffer = crunker.concatAudio(audioBuffers);
      const output = crunker.export(mergedAudioBuffer, "audio/mp3");
      crunker.download(output.blob);

      generateButton.innerHTML = generateStr;
    } catch (e) {
      generateButton.innerHTML = "Error generating audio";
      document.querySelector("#readability")!.innerHTML = String(e);
    }
  });
});
