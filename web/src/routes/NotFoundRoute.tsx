import { Link } from "react-router";

import { PageFrame } from "../app/PageFrame";
import { EmptyState } from "../components/states/EmptyState";
import { Button } from "../components/ui/Button";
import { ROUTES } from "./routes";

export function NotFoundRoute() {
  return (
    <PageFrame title="not found">
      <EmptyState
        title="Nothing at this address"
        hint="Check the address, or go back to the list of runs."
        action={
          <Button asChild>
            <Link to={ROUTES.runs}>Open runs</Link>
          </Button>
        }
      />
    </PageFrame>
  );
}
