import { createFileRoute } from "@tanstack/react-router";
import { TicketSettings } from "../components/tickets/TicketSettings";
export const Route = createFileRoute("/settings/tickets")({ component: TicketSettings });
