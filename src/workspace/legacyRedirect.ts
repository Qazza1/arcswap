import { appPath } from "../shared/appOrigin";

// Navigation only: no provider call, wallet signature, session token, or query
// parameter is transferred while moving a legacy route to the app workspace.
window.location.replace(appPath("/dashboard"));
