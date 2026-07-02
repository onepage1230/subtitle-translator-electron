import fs from "node:fs";
import { parseSync, stringifySync } from "subtitle";
import assParser from "ass-parser";
import assStringify from "ass-stringify";

function splitIntoChunk(array: any[], by = 5) {
  let chunks = [];
  let chunk = [];
  for (let i = 0; i < array.length; i++) {
    if (array[i].data?.translatedText) continue;
    chunk.push(array[i]);
    if (chunk.length === by) {
      chunks.push(chunk);
      chunk = [];
    }
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

function parseSubtitle(fileContent: string, fileExtension: string) {
  if (["srt", "vtt"].includes(fileExtension)) {
    return parseSync(fileContent);
  }
  if (["ass", "ssa"].includes(fileExtension)) {
    const parsedAssSubtitle = assParser(fileContent);
    const events = parsedAssSubtitle
      .filter((x: any) => x.section === "Events")[0]
      .body.filter(({ key }: any) => key === "Dialogue")
      .map((line: any) => {
        return {
          type: `cue`,
          data: {
            text: line.value.Text,
            start: line.value.Start,
            end: line.value.End,
          },
        };
      });
    return { full: parsedAssSubtitle, events };
  }
  throw new Error("Unsupported file extension");
}

function saveTranslated(
  outputPath: string,
  parsedSubtitle: any,
  fileExtension: string,
  multiLangSave: string = "none"
) {
  function parseTranslatedText(
    originalSubtitle: string = "",
    translatedText: string = "",
    splitText: string = "\n"
  ) {
    switch (multiLangSave) {
      case "none":
        return translatedText;
      case "translate+original":
        return `${translatedText}${splitText}${originalSubtitle}`;
      case "original+translate":
        return `${originalSubtitle}${splitText}${translatedText}`;
    }
  }

  let newSubtitle;
  if (["srt", "vtt"].includes(fileExtension)) {
    const format = fileExtension === "vtt" ? "WebVTT" : "SRT";
    newSubtitle = stringifySync(
      parsedSubtitle.map((x) => {
        return {
          type: x.type,
          data: {
            ...x.data,
            text: parseTranslatedText(
              x.data.text,
              (x.data.translatedText === "__FAILED__" ? "" : x.data.translatedText) || x.data.text
            ),
          },
        };
      }),
      { format }
    );
  }

  if (["ass", "ssa"].includes(fileExtension)) {
    const { full, events } = parsedSubtitle;
    // Use sequential alignment with Events order instead of text matching to avoid misalignment
    let dialogueIndex = 0;
    newSubtitle = assStringify(
      full.map((x: any) => {
        if (x.section === "Events") {
          x.body = x.body.map((line: any) => {
            if (line.key === "Dialogue") {
              const currentEvent = events[dialogueIndex++];
              const rawTranslated =
                currentEvent && currentEvent.data
                  ? currentEvent.data.translatedText
                  : undefined;
              const translatedText =
                rawTranslated === "__FAILED__" || !rawTranslated
                  ? line.value.Text
                  : rawTranslated;
              return {
                key: "Dialogue",
                value: {
                  ...line.value,
                  Text: parseTranslatedText(
                    line.value.Text,
                    translatedText,
                    "\\n"
                  ),
                },
              };
            }
            return line;
          });
        }
        return x;
      })
    );
  }

  // Atomic write to avoid renderer reading partial file during concurrent updates
  const tmpPath = `${outputPath}.tmp`;
  fs.writeFileSync(tmpPath, newSubtitle, "utf8");
  try {
    fs.renameSync(tmpPath, outputPath);
  } catch {
    // Fallback for filesystems where rename might not be atomic
    fs.writeFileSync(outputPath, newSubtitle, "utf8");
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
  }
}

export function normalizeCues(parsed: any): any[] {
  if (Array.isArray(parsed)) {
    return parsed.filter((line: any) => line.type === "cue");
  }
  if (parsed && parsed.events) {
    return parsed.events;
  }
  return parsed;
}

export { parseSubtitle, saveTranslated, splitIntoChunk };
