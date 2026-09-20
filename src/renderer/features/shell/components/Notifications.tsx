import { useNotificationStore } from "../../../state/notificationStore";
import { IconClose } from "../icons";

export function Notifications(): JSX.Element {
  const notifications = useNotificationStore((state) => state.notifications);
  const dismiss = useNotificationStore((state) => state.dismiss);

  return (
    <div
      className="pointer-events-none fixed right-4 top-12 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
      aria-live="assertive"
      aria-atomic="false"
    >
      {notifications.map((notification) => (
        <div
          key={notification.id}
          role="alert"
          className="pointer-events-auto flex items-start gap-3 rounded-lg border border-red-500/40 bg-[#211318] px-3 py-2.5 text-sm text-red-100 shadow-xl"
        >
          <span className="min-w-0 flex-1 break-words">{notification.message}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismiss(notification.id)}
            className="grid size-6 shrink-0 place-items-center rounded text-red-200/70 hover:bg-white/10 hover:text-red-100"
          >
            <IconClose width={14} height={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
