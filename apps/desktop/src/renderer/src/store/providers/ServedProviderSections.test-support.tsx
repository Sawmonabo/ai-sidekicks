// The provider list served to a subtree, as the app holds it above every window, for suites that
// draw a view naming a provider.

import type { ReactNode } from "react";

import { ProviderSectionsContext } from "./hooks/useProviderSections.js";
import { providerSectionsFixture } from "./sections.test-support.js";

/** The fixture's sections served to `children`. */
export function ServedProviderSections(props: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <ProviderSectionsContext.Provider
      value={{ status: "served", sections: providerSectionsFixture() }}
    >
      {props.children}
    </ProviderSectionsContext.Provider>
  );
}
