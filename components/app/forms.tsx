"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Rss } from "lucide-react";
import ConfirmModal from "@/components/ConfirmModal";
import {
  DomainPicker,
  LengthPicker,
  LevelPicker,
  ModuleList,
  ScheduleFields,
  StackPicker,
  withModuleDefaults,
  type ModuleSetting,
} from "@/components/prefs/fields";
import { Button, Card, CardHeader, Input, Label, Switch } from "@/components/ui";
import { useNotification } from "@/contexts/NotificationContext";
import { deleteAccount, saveMe } from "@/lib/api-client";
import { signOut } from "@/lib/sign-out";
import type { Me, ProfileUpdateInput } from "@/lib/profile";

/**
 * Shared save behaviour for the settings forms: one button that is only live
 * when something changed, and a toast either way.
 */
function useSave() {
  const router = useRouter();
  const { showError, showSuccess } = useNotification();
  const [saving, setSaving] = useState(false);

  async function save(patch: ProfileUpdateInput, done?: () => void) {
    setSaving(true);
    try {
      await saveMe(patch);
      showSuccess("Saved");
      done?.();
      // Server components on this and other pages read the same profile.
      router.refresh();
    } catch (err) {
      showError("Could not save", err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  }

  return { saving, save };
}

/**
 * Appears only when there is something to save. A bar that is always there
 * covers content for no reason, and a button that is usually disabled teaches
 * people to ignore it.
 */
function SaveBar({ dirty, saving, onSave }: { dirty: boolean; saving: boolean; onSave: () => void }) {
  if (!dirty && !saving) return null;
  return (
    <div className="pointer-events-none sticky bottom-20 z-10 mt-8 flex justify-end lg:bottom-6">
      <div className="pointer-events-auto flex animate-fade-up items-center gap-3 rounded-xl border border-line bg-surface/95 p-2 pl-4 shadow-pop backdrop-blur">
        <span className="font-mono text-[12px] text-subtle">unsaved changes</span>
        <Button onClick={onSave} loading={saving}>
          Save
        </Button>
      </div>
    </div>
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/* ---------------------------------------------------------------- Topics -- */

export function TopicsForm({ initial }: { initial: Me }) {
  const { saving, save } = useSave();
  const [saved, setSaved] = useState({
    domains: initial.profile.domains,
    stack: initial.profile.stack,
    level: initial.profile.level,
    digest_length: initial.profile.digest_length,
  });
  const [draft, setDraft] = useState(saved);
  const dirty = !same(saved, draft);

  return (
    <div>
      <div className="space-y-5">
        <Card>
          <CardHeader title="What you build" description="Up to four. This decides what counts as news for you." />
          <div className="p-5">
            <DomainPicker value={draft.domains} onChange={(domains) => setDraft({ ...draft, domains })} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Your stack" description="Specific picks rank highest. Stories about these lead your issues." />
          <div className="p-5">
            <StackPicker
              value={draft.stack}
              onChange={(stack) => setDraft({ ...draft, stack })}
              domains={draft.domains}
            />
          </div>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Level" />
            <div className="p-5">
              <LevelPicker value={draft.level} onChange={(level) => setDraft({ ...draft, level })} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Digest length" />
            <div className="p-5">
              <LengthPicker
                value={draft.digest_length}
                onChange={(digest_length) => setDraft({ ...draft, digest_length })}
              />
            </div>
          </Card>
        </div>
      </div>

      <SaveBar
        dirty={dirty && draft.domains.length > 0}
        saving={saving}
        onSave={() => save(draft, () => setSaved(draft))}
      />
    </div>
  );
}

/* -------------------------------------------------------------- Schedule -- */

export function ScheduleForm({ initial }: { initial: Me }) {
  const { saving, save } = useSave();
  const [saved, setSaved] = useState({
    subscriptions: withModuleDefaults(initial.subscriptions) as ModuleSetting[],
    send_time: initial.profile.send_time,
    timezone: initial.profile.timezone,
    is_paused: initial.profile.is_paused,
  });
  const [draft, setDraft] = useState(saved);
  const dirty = !same(saved, draft);

  return (
    <div>
      <div className="space-y-5">
        <Card>
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div>
              <p className="text-[15px] font-semibold tracking-tight">
                {draft.is_paused ? "Email is paused" : "Email is on"}
              </p>
              <p className="mt-0.5 text-[13px] text-muted">
                Pausing keeps every setting. Nothing is sent until you switch it back on.
              </p>
            </div>
            <Switch
              checked={!draft.is_paused}
              onChange={(on) => setDraft({ ...draft, is_paused: !on })}
              label="Receive email"
            />
          </div>
        </Card>

        <div>
          <h2 className="mb-3 text-[15px] font-semibold tracking-tight">Modules</h2>
          <ModuleList
            value={draft.subscriptions}
            onChange={(subscriptions) => setDraft({ ...draft, subscriptions })}
          />
        </div>

        <Card>
          <CardHeader
            title="Delivery time"
            description="One email a day at most. Everything due that day is bundled into it."
          />
          <div className="p-5">
            <ScheduleFields
              sendTime={draft.send_time}
              timezone={draft.timezone}
              onChange={(next) => setDraft({ ...draft, send_time: next.sendTime, timezone: next.timezone })}
            />
          </div>
        </Card>
      </div>

      <SaveBar dirty={dirty} saving={saving} onSave={() => save(draft, () => setSaved(draft))} />
    </div>
  );
}

/* -------------------------------------------------------------- Settings -- */

export function SettingsPanel({ initial, feedUrl }: { initial: Me; feedUrl: string }) {
  const router = useRouter();
  const { showError, showSuccess } = useNotification();
  const { saving, save } = useSave();

  const [savedName, setSavedName] = useState(initial.profile.display_name ?? "");
  const [name, setName] = useState(savedName);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function copyFeed() {
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showError("Could not copy", "Select the address and copy it by hand.");
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteAccount();
      await signOut();
      showSuccess("Account deleted");
      router.push("/");
      router.refresh();
    } catch (err) {
      showError("Could not delete the account", err instanceof Error ? err.message : undefined);
      setDeleting(false);
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Account" />
        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" value={initial.profile.email} readOnly disabled />
            <p className="text-[12px] text-subtle">Issues are sent here.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <div className="flex gap-2">
              <Input
                id="name"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                placeholder="What should we call you?"
              />
              <Button
                variant="secondary"
                loading={saving}
                disabled={name.trim() === savedName}
                onClick={() => save({ display_name: name.trim() || null }, () => setSavedName(name.trim()))}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Your feed"
          description="Every issue, as a private Atom feed. Works in any feed reader."
        />
        <div className="p-5">
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Rss className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
              <Input
                readOnly
                value={feedUrl}
                aria-label="Feed address"
                onFocus={(e) => e.currentTarget.select()}
                className="pl-9 font-mono text-[12px]"
              />
            </div>
            <Button variant="secondary" onClick={copyFeed}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-3 text-[12px] text-subtle">
            Anyone with this address can read your issues, so treat it like a password.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title="Delete account" description="Removes your profile, schedule, history and feedback. This cannot be undone." />
        <div className="p-5">
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Delete my account
          </Button>
        </div>
      </Card>

      <ConfirmModal
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={handleDelete}
        title="Delete your account?"
        message="Everything tied to your account is removed straight away and cannot be recovered. You will stop receiving email."
        confirmLabel="Delete account"
        tone="danger"
        isLoading={deleting}
      />
    </div>
  );
}
