import { MarkdownRenderer } from "./src/markdown/renderer.js";

const renderer = new MarkdownRenderer();

const testMarkdown = "# 🤖 CHAVES\n\n**Current Focus**: Testing markdown rendering\n\n**Recent Steps**:\n- Created a test file\n- Verified Glow is working\n\n**Likely Next**: Continue testing";

renderer.render(testMarkdown).then((result) => {
  console.log("Markdown rendering test result:");
  console.log(result);
}).catch((error) => {
  console.error("Error:", error.message);
});
