import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import {
  ProjectId,
  type EnvironmentId,
  type TicketProjectsResult,
  type TicketSetupCheck,
} from "@t3tools/contracts";
import { ticketEnvironment, ticketEnvironmentIdsAtom } from "../../state/tickets";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { SettingsPageContainer } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { TicketPicker } from "./TicketPicker";

export function TicketSettings() {
  const ids = useAtomValue(ticketEnvironmentIdsAtom);
  const { environment } = useSettingsScope();
  const [selected, setSelected] = useState<string | null>(null);
  const configs = useServerConfigs();
  const id =
    ids.find((id) => id === selected) ??
    ids.find((id) => id === environment?.environmentId) ??
    ids[0];
  return (
    <SettingsPageContainer>
      <h2 className="text-lg font-medium">Tickets</h2>
      <TicketPicker
        label="Environment"
        value={id ?? ""}
        options={ids.map((id) => ({ value: id, label: configs.get(id)?.environment.label ?? id }))}
        onChange={setSelected}
      />
      {id ? (
        <EnvironmentTicketSettings key={id} environmentId={id} />
      ) : (
        <p>Connect an environment that supports tickets.</p>
      )}
    </SettingsPageContainer>
  );
}
function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The request failed. Your input is kept.";
}
function EnvironmentTicketSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const narrow = useMediaQuery("(max-width: 480px)");
  const query = ticketEnvironment.syncStatus({ environmentId, input: {} });
  const status = useAtomValue(query);
  const reload = useAtomRefresh(query);
  const projectsQuery = ticketEnvironment.projectsList({ environmentId, input: {} });
  const mappings = useAtomValue(projectsQuery);
  const reloadProjects = useAtomRefresh(projectsQuery);
  const configure = useAtomCommand(ticketEnvironment.syncConfigure);
  const refresh = useAtomCommand(ticketEnvironment.syncRefresh);
  const check = useAtomCommand(ticketEnvironment.setupCheck);
  const setLabel = useAtomCommand(ticketEnvironment.machineLabel);
  const allowed = useAtomValue(ticketEnvironment.syncConfigure.permissionAtom(environmentId));
  const settings = useEnvironmentSettings(environmentId);
  const update = useUpdateEnvironmentSettings(environmentId);
  const [remote, setRemote] = useState("");
  const [label, setMachineLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<TicketSetupCheck | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- polls sync status while the settings are open
  useEffect(() => {
    const timer = setInterval(reload, 15000);
    return () => clearInterval(timer);
  }, [reload]);
  const value = AsyncResult.isSuccess(status) ? status.value : null;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } finally {
      setBusy(false);
      reload();
      reloadProjects();
    }
  };
  return (
    <div className="grid gap-5">
      <section className="grid gap-3" aria-label="Ticket sync setup">
        <label className="grid gap-1.5">
          Remote URL
          <Input
            size={narrow ? "touch" : "default"}
            aria-label="Ticket remote URL"
            value={remote || value?.remote || ""}
            onChange={(e) => setRemote(e.target.value)}
            disabled={busy || !allowed}
            placeholder="Git remote URL or local bare repository"
          />
        </label>
        {value?.configured ? (
          <p className="text-sm text-muted-foreground">
            Already configured. To change remotes, preserve or move this environment’s clone first.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size={narrow ? "touch" : "default"}
            disabled={busy || !allowed || !(remote || value?.remote)}
            onClick={() =>
              void run(async () => {
                const result = await configure({
                  environmentId,
                  input: { remoteUrl: remote || value!.remote! },
                });
                if (result._tag === "Failure") setError(failureMessage(result));
              })
            }
          >
            Configure remote
          </Button>
          <Button
            size={narrow ? "touch" : "default"}
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await refresh({ environmentId, input: {} });
                if (result._tag === "Failure") setError(failureMessage(result));
              })
            }
          >
            Refresh
          </Button>
          <Button
            size={narrow ? "touch" : "default"}
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await check({ environmentId, input: {} });
                if (result._tag === "Success") setChecks(result.value);
                else setError(failureMessage(result));
              })
            }
          >
            Check setup
          </Button>
        </div>
        {value ? (
          <dl className="grid gap-1 text-sm">
            <div>
              <dt className="inline font-medium">Remote: </dt>
              <dd className="inline break-all">{value.remote ?? "Not configured"}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Last pull: </dt>
              <dd className="inline">
                {value.lastPullAt ? new Date(value.lastPullAt).toLocaleString() : "Never"}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Last push: </dt>
              <dd className="inline">
                {value.lastPushAt ? new Date(value.lastPushAt).toLocaleString() : "Never"}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Pending: </dt>
              <dd className="inline">{value.pendingEvents}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Last error: </dt>
              <dd className="inline wrap-anywhere">{value.lastError ?? "None"}</dd>
            </div>
          </dl>
        ) : (
          <p>Loading sync status…</p>
        )}
        {checks ? (
          <div aria-live="polite" className="grid gap-1 text-sm wrap-anywhere">
            <p>Clone present: {checks.clonePresent ? "Yes" : "No"}</p>
            <p>Remote reachable: {checks.remoteReachable ? "Yes" : "No"}</p>
            <p>
              Authentication: {checks.authOk === null ? "Unknown" : checks.authOk ? "OK" : "Failed"}
            </p>
            <p>Registry parsed: {checks.registryParsed ? "Yes" : "No"}</p>
            {checks.messages.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive wrap-anywhere">
            {error}
          </p>
        ) : null}
      </section>
      <label className="grid gap-1.5">
        Machine label
        <Input
          size={narrow ? "touch" : "default"}
          aria-label="Ticket machine label"
          value={label ?? value?.label ?? ""}
          onChange={(e) => setMachineLabel(e.target.value)}
          disabled={busy || !allowed}
        />
      </label>
      <Button
        size={narrow ? "touch" : "default"}
        variant="outline"
        disabled={busy || !allowed || !label?.trim()}
        onClick={() =>
          void run(async () => {
            const result = await setLabel({ environmentId, input: { label: label!.trim() } });
            if (result._tag === "Failure") setError(failureMessage(result));
          })
        }
      >
        Save machine label
      </Button>
      <label className="flex items-center justify-between gap-3">
        Handoff reminders
        <Switch
          aria-label="Ticket handoff reminders"
          checked={settings.ticketHandoffNudge}
          disabled={!allowed}
          onCheckedChange={(checked) => update({ ticketHandoffNudge: Boolean(checked) })}
        />
      </label>
      <label className="flex items-center justify-between gap-3">
        Triage new Ideas
        <Switch
          aria-label="Ticket triage"
          checked={settings.ticketTriage}
          disabled={!allowed}
          onCheckedChange={(checked) => update({ ticketTriage: Boolean(checked) })}
        />
      </label>
      <section aria-label="Ticket project mappings" className="grid gap-3">
        <h3 className="font-medium">Ticket ID prefixes and local registrations</h3>
        <p className="text-sm text-muted-foreground">
          A prefix keeps existing Ticket IDs stable, including legacy prefixes. Map it to this
          machine’s T3 registration to launch work here. The durable Project identity lives in its
          Home README; changing this mapping does not rename it or move files.
        </p>
        {AsyncResult.isSuccess(mappings) ? (
          mappings.value.projects.map((mapping) => (
            <ProjectMapping
              key={mapping.key}
              environmentId={environmentId}
              mapping={mapping}
              onSaved={reloadProjects}
            />
          ))
        ) : (
          <p>Loading project registry…</p>
        )}
      </section>
    </div>
  );
}
function ProjectMapping({
  environmentId,
  mapping,
  onSaved,
}: {
  environmentId: EnvironmentId;
  mapping: TicketProjectsResult["projects"][number];
  onSaved: () => void;
}) {
  const narrow = useMediaQuery("(max-width: 480px)");
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const [selected, setSelected] = useState<string>(
    mapping.projectId ?? mapping.suggestedProjectId ?? "none",
  );
  const [name, setName] = useState(mapping.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const map = useAtomCommand(ticketEnvironment.projectsMap);
  const allowed = useAtomValue(ticketEnvironment.projectsMap.permissionAtom(environmentId));
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <p className="text-sm font-medium">
        Ticket ID prefix: {mapping.key}
        {!mapping.projectId && mapping.suggestedProjectId ? " · Suggested local match" : ""}
      </p>
      <Input
        size={narrow ? "touch" : "default"}
        aria-label={`Display name for ${mapping.key}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy || !allowed}
      />
      <TicketPicker
        label={`Registration on this machine for ${mapping.key}`}
        value={selected}
        options={[
          { value: "none", label: "Unmapped" },
          ...projects.map((p) => ({ value: p.id, label: `${p.title} · ${p.workspaceRoot}` })),
        ]}
        onChange={setSelected}
        disabled={busy || !allowed}
      />
      <Button
        size={narrow ? "touch" : "default"}
        variant="outline"
        disabled={busy || !allowed || !name.trim()}
        onClick={() => {
          setBusy(true);
          void map({
            environmentId,
            input: {
              key: mapping.key,
              projectId: selected === "none" ? null : ProjectId.make(selected),
              displayName: name.trim(),
            },
          })
            .then((result) => {
              if (result._tag === "Failure") setError(failureMessage(result));
              else {
                setError(null);
                onSaved();
              }
            })
            .finally(() => setBusy(false));
        }}
      >
        Confirm mapping and name
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
