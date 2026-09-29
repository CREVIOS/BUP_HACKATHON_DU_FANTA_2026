"use client";

import { createContext, useContext } from "react";
import type { Target } from "@/lib/targets";

// Lets any component (map cards, alert rows) take the operator to another tab or section.
const NavigationContext = createContext<(target: Target) => void>(() => undefined);

export const NavigationProvider = NavigationContext.Provider;
export const useNavigate = () => useContext(NavigationContext);
