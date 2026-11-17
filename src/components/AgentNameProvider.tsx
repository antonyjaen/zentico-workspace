"use client";

// The user's assistant name ("Claude", "Codex", or their own pick) for client code that builds text
// outside the message catalogs. Messages get it server-side already (src/i18n/request.ts fills
// {agent}); the apps layout passes the same value here, so both agree without a fetch.
import { createContext, useContext } from "react";

const AgentNameContext = createContext<string>("Assistant");

export function AgentNameProvider({ name, children }: { name: string; children: React.ReactNode }) {
  return <AgentNameContext.Provider value={name}>{children}</AgentNameContext.Provider>;
}

export const useAgentName = () => useContext(AgentNameContext);
