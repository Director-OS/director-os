import { sharedModule } from "@director-os/shared";
import { uiModule } from "@director-os/ui";

export const directorOSWebFoundation = {
  name: "Director OS Web",
  status: "initialized",
  modules: [sharedModule, uiModule]
};

console.log(`${directorOSWebFoundation.name}: ${directorOSWebFoundation.status}`);
