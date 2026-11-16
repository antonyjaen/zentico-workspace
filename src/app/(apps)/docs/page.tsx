import { permanentRedirect } from "next/navigation";

// Docs lives inside Drive now: the old home is Drive's Documents section. The editors stay at
// /docs/edit|draw|md/<id> (links from MCP tools, chat and stored URLs point there).
export default function DocsPage() {
  permanentRedirect("/drive?view=docs");
}
