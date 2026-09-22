import { createContext, use } from "react";

import { api, type ApiClient } from "./client";

/** Lets tests hand every hook a client wired to a fake fetch; production uses the default. */
export const ApiClientContext = createContext<ApiClient>(api);

export function useApiClient(): ApiClient {
  return use(ApiClientContext);
}
