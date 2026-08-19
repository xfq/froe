import OpenAI from "openai";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Set OPENAI_API_KEY before running pnpm smoke:openai");
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 2 });
const response = await client.responses.create({
  model: "gpt-5.6-terra",
  input: "Reply with exactly: froe smoke test passed",
  store: false,
});
console.log(response.output_text);
