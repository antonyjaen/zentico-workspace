import { redirect } from "next/navigation";

// Recordings are listed on the Meet landing page; this keeps /meet/recordings from being read as a room code.
export default function RecordingsIndex() {
  redirect("/meet");
}
