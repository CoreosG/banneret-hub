import { skillUri, tools } from "./index.ts";

export function referenceSkills() {
  const entry = { name: "deploy", description: "Deploy the service" };
  const text = "---\nname: deploy\ndescription: Deploy the service\n---\nRun the release checks.";
  return {
    async callTool(name: string, args: unknown) {
      if (name === "acme_skills_list") {
        tools.skills_list.input.parse(args);
        return { structuredContent: { skills: [entry] } };
      }
      if (name === "acme_skills_get" && tools.skills_get.input.parse(args).name === entry.name) {
        return { structuredContent: { ...entry, text } };
      }
      return { isError: true };
    },
    async readResource(uri: string) {
      if (uri !== skillUri(entry.name)) throw new Error("Unknown resource");
      return { contents: [{ uri, mimeType: "text/markdown", text }] };
    },
  };
}
