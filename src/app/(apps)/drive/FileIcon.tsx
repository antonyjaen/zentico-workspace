import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { kindOf, type Kind } from "./shared";

const ICONS: Record<Kind, { icon: LucideIcon; color: string }> = {
  folder: { icon: Folder, color: "var(--color-ink-mute)" },
  image: { icon: FileImage, color: "#8b5cf6" },
  pdf: { icon: FileText, color: "var(--color-danger)" },
  video: { icon: FileVideo, color: "#db2777" },
  audio: { icon: FileAudio, color: "#0891b2" },
  text: { icon: FileText, color: "var(--color-ink-mute)" },
  document: { icon: FileText, color: "var(--color-app-mail)" },
  spreadsheet: { icon: FileSpreadsheet, color: "var(--color-signal)" },
  presentation: { icon: Presentation, color: "var(--color-amber)" },
  archive: { icon: FileArchive, color: "var(--color-ink-mute)" },
  code: { icon: FileCode, color: "var(--color-ink-mute)" },
  other: { icon: File, color: "var(--color-ink-mute)" },
};

export function FileIcon({ item, size = 18 }: { item: { name: string; isFolder: boolean; type: string }; size?: number }) {
  const { icon: Icon, color } = ICONS[kindOf(item)];
  return <Icon size={size} aria-hidden className="shrink-0" style={{ color }} fill={item.isFolder ? "currentColor" : "none"} fillOpacity={item.isFolder ? 0.15 : 0} />;
}
