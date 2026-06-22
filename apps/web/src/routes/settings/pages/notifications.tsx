import { useCallback, useEffect, useState } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  getNotifyOnDeployFailure,
  setNotifyOnDeployFailure,
  type NotificationPermissionState,
} from "@/lib/deploy-notifications";
import { useUiApi } from "@/lib/api-context";
import type { NotificationsConfigView } from "@/lib/ui-api";
import {
  NOTIFICATION_KIND_ROWS,
  ruleOf,
  ruleUpdate,
  telegramUpdate,
} from "@/lib/notifications-settings";
import {
  getSoundSettings,
  setSoundSettings,
  soundSettingForKind,
  SOUND_OPTIONS,
  type SoundSettings,
} from "@/lib/notification-sound";
import { previewSound } from "@/lib/notification-sound-bridge";
import { enableWebPush, isWebPushSupported } from "@/lib/push-subscribe";
import { FormRow, Section, SelectInput, TextInput } from "../shared";

function readPermission(): NotificationPermissionState {
  if (typeof Notification === "undefined") return "denied";
  return Notification.permission as NotificationPermissionState;
}

const localStorageOrNull =
  typeof localStorage !== "undefined" ? localStorage : null;

export function NotificationsPage() {
  const api = useUiApi();
  const [config, setConfig] = useState<NotificationsConfigView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sound, setSound] = useState<SoundSettings>(() =>
    getSoundSettings(localStorageOrNull),
  );
  const [tokenDraft, setTokenDraft] = useState("");
  const [chatIdDraft, setChatIdDraft] = useState("");
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);
  const [pushStatus, setPushStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .getNotifications()
      .then((res) => {
        if (cancelled) return;
        setConfig(res.config);
        setChatIdDraft(res.config.channels.telegram.chatId);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const applyUpdate = useCallback(
    async (update: Parameters<typeof api.saveNotifications>[0]) => {
      const res = await api.saveNotifications(update);
      setConfig(res.config);
    },
    [api],
  );

  const updateSound = useCallback((next: SoundSettings) => {
    setSound(next);
    setSoundSettings(localStorageOrNull, next);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <DeployFailureSection />

      <Section title="Agent notifications" id="settings-section-agent-notifications">
        {loadError && (
          <FormRow label="Notifications">
            <p className="text-[12.5px] text-[color:var(--bad)] m-0">
              Could not load notification settings: {loadError}
            </p>
          </FormRow>
        )}
        {config &&
          NOTIFICATION_KIND_ROWS.map((row) => {
            const rule = ruleOf(config, row.kind);
            const setting = soundSettingForKind(sound, row.kind);
            return (
              <FormRow key={row.kind} label={row.label} hint={row.description}>
                <div className="flex flex-col gap-2.5">
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <Checkbox
                      checked={rule.enabled}
                      onCheckedChange={(v) =>
                        void applyUpdate(ruleUpdate(config, row.kind, { enabled: v }))
                      }
                      data-testid={`notify-${row.kind}-enabled`}
                    >
                      Notify
                    </Checkbox>
                    <Checkbox
                      checked={rule.channels.telegram}
                      onCheckedChange={(v) =>
                        void applyUpdate(ruleUpdate(config, row.kind, { telegram: v }))
                      }
                    >
                      Telegram
                    </Checkbox>
                    <Checkbox
                      checked={rule.channels.webpush}
                      onCheckedChange={(v) =>
                        void applyUpdate(ruleUpdate(config, row.kind, { webpush: v }))
                      }
                    >
                      Web Push
                    </Checkbox>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <SelectInput
                      value={setting.soundId}
                      onChange={(soundId) =>
                        updateSound({
                          ...sound,
                          byKind: {
                            ...sound.byKind,
                            [row.kind]: { ...setting, soundId },
                          },
                        })
                      }
                      options={SOUND_OPTIONS.map((o) => ({
                        value: o.id,
                        label: o.label,
                      }))}
                      data-testid={`notify-${row.kind}-sound`}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => previewSound(setting.soundId, sound.master)}
                      disabled={setting.soundId === "none"}
                    >
                      <Play /> Test
                    </Button>
                    <label className="flex items-center gap-1.5 text-[12.5px] text-[color:var(--ink-2)]">
                      Loop cap
                      <input
                        type="number"
                        min={0}
                        value={Math.round(setting.durationMs / 1000)}
                        onChange={(e) =>
                          updateSound({
                            ...sound,
                            byKind: {
                              ...sound.byKind,
                              [row.kind]: {
                                ...setting,
                                durationMs:
                                  Math.max(0, Number(e.target.value) || 0) * 1000,
                              },
                            },
                          })
                        }
                        className="w-16 rounded-md border border-[color:var(--hair-2)] bg-[color:var(--surface)] px-2 py-1 text-[13px] text-[color:var(--ink)] outline-none"
                      />
                      s
                    </label>
                  </div>
                </div>
              </FormRow>
            );
          })}
      </Section>

      {config && (
        <Section title="Telegram" id="settings-section-telegram">
          <FormRow
            label="Bot token"
            hint={
              <>
                Create a bot with{" "}
                <a
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  @BotFather
                </a>{" "}
                and paste its token. Leave blank to keep the saved token.
              </>
            }
          >
            <TextInput
              type="password"
              value={tokenDraft}
              onChange={setTokenDraft}
              placeholder={
                config.channels.telegram.botToken ? "•••••• (saved)" : "123456:ABC-DEF…"
              }
              data-testid="telegram-token"
            />
          </FormRow>
          <FormRow
            label="Chat id"
            hint={
              <>
                Message your bot, then open{" "}
                <code>https://api.telegram.org/bot&lt;token&gt;/getUpdates</code> and
                copy the <code>chat.id</code>.
              </>
            }
          >
            <div className="flex flex-col gap-2">
              <TextInput
                value={chatIdDraft}
                onChange={setChatIdDraft}
                placeholder="987654321"
                data-testid="telegram-chat-id"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Checkbox
                  checked={config.channels.telegram.enabled}
                  onCheckedChange={(v) =>
                    void applyUpdate(telegramUpdate({ enabled: v }))
                  }
                >
                  Enable Telegram
                </Checkbox>
                <Button
                  type="button"
                  size="sm"
                  onClick={async () => {
                    setTelegramStatus("Saving…");
                    await applyUpdate(
                      telegramUpdate({
                        chatId: chatIdDraft,
                        ...(tokenDraft ? { botToken: tokenDraft } : {}),
                      }),
                    );
                    setTokenDraft("");
                    setTelegramStatus("Saved.");
                  }}
                >
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    setTelegramStatus("Sending test…");
                    const result = await api.sendTestNotification("telegram");
                    setTelegramStatus(
                      result.ok
                        ? "Test message sent."
                        : `Test failed: ${result.error ?? "unknown error"}`,
                    );
                  }}
                >
                  Send test
                </Button>
              </div>
              {telegramStatus && (
                <p
                  className="text-[12.5px] text-[color:var(--muted-foreground)] m-0"
                  data-testid="telegram-status"
                >
                  {telegramStatus}
                </p>
              )}
            </div>
          </FormRow>
          <FormRow
            label="Delivery"
            hint="When away: deliver only while no browser window is focused (same as Web Push). Always: deliver every alert, even while you are watching WorktreeOS — Telegram reaches a separate device."
          >
            <SelectInput
              value={config.channels.telegram.mode}
              onChange={(mode) => void applyUpdate(telegramUpdate({ mode }))}
              options={[
                { value: "when-away", label: "Only when away" },
                { value: "always", label: "Always" },
              ]}
              data-testid="telegram-mode"
            />
          </FormRow>
        </Section>
      )}

      {config && (
        <Section title="Web Push" id="settings-section-webpush">
          <FormRow
            label="This device"
            hint="Subscribe this browser to receive notifications even when the tab is closed. Requires notification permission."
          >
            <div className="flex flex-col gap-1.5">
              <div>
                <Button
                  type="button"
                  size="sm"
                  disabled={!isWebPushSupported()}
                  onClick={async () => {
                    setPushStatus("Enabling…");
                    const result = await enableWebPush(api);
                    setPushStatus(
                      result.ok
                        ? "Web Push enabled on this device."
                        : `Could not enable: ${
                            result.reason === "permission-denied"
                              ? "permission denied"
                              : result.message ?? result.reason
                          }`,
                    );
                  }}
                  data-testid="webpush-enable"
                >
                  Enable on this device
                </Button>
              </div>
              {!isWebPushSupported() && (
                <p className="text-[12.5px] text-[color:var(--muted-foreground)] m-0">
                  This browser does not support Web Push.
                </p>
              )}
              {pushStatus && (
                <p
                  className="text-[12.5px] text-[color:var(--muted-foreground)] m-0"
                  data-testid="webpush-status"
                >
                  {pushStatus}
                </p>
              )}
            </div>
          </FormRow>
        </Section>
      )}
    </div>
  );
}

/**
 * Per-device opt-in for OS notifications on deploy failures and healthcheck
 * degradation. Stored client-side (localStorage), separate from the agent
 * notification engine.
 */
function DeployFailureSection() {
  const supported = typeof Notification !== "undefined";
  const [enabled, setEnabled] = useState(() =>
    getNotifyOnDeployFailure(localStorageOrNull),
  );
  const [permission, setPermission] = useState<NotificationPermissionState>(
    () => readPermission(),
  );

  const handleToggle = useCallback(
    async (next: boolean) => {
      setEnabled(next);
      setNotifyOnDeployFailure(localStorageOrNull, next);
      if (next && supported && Notification.permission === "default") {
        try {
          const result = await Notification.requestPermission();
          setPermission(result as NotificationPermissionState);
        } catch {
          setPermission(readPermission());
        }
      }
    },
    [supported],
  );

  return (
    <Section title="Deploy notifications" id="settings-section-notifications">
      <FormRow
        label="Deploy failure notifications"
        hint="Per-device. Raises an OS notification when a deploy fails or a healthcheck degrades, even when this tab is in the background. Stored on this device only — not synced through the daemon config."
      >
        <div className="flex flex-col gap-1.5">
          <Checkbox
            checked={enabled}
            onCheckedChange={(v) => void handleToggle(v)}
            disabled={!supported}
            data-testid="settings-notify-deploy-failure"
          >
            Notify on deploy failures
          </Checkbox>
          {!supported && (
            <p
              className="text-[12.5px] text-[color:var(--muted-foreground)] m-0"
              data-testid="settings-notify-unsupported"
            >
              This browser does not support notifications.
            </p>
          )}
          {supported && enabled && permission === "granted" && (
            <p
              className="text-[12.5px] text-[color:var(--good)] m-0"
              data-testid="settings-notify-granted"
            >
              Notifications are enabled for this device.
            </p>
          )}
          {supported && enabled && permission === "denied" && (
            <p
              className="text-[12.5px] text-[color:var(--bad)] m-0"
              data-testid="settings-notify-denied"
            >
              Notification permission is blocked. Notifications cannot be shown
              until you allow them for this site in your browser settings.
            </p>
          )}
          {supported && enabled && permission === "default" && (
            <p
              className="text-[12.5px] text-[color:var(--muted-foreground)] m-0"
              data-testid="settings-notify-default"
            >
              Permission has not been requested yet.
            </p>
          )}
        </div>
      </FormRow>
    </Section>
  );
}
