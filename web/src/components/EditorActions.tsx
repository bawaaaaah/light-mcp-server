import type { ComponentProps, ReactElement, ReactNode, Ref } from "react";
import { useT } from "../App";
import { Versions } from "./Versions";

/**
 * The footer of an editor (T47): « Enregistrer », what the editor adds beside it, « Fermer », « Supprimer » for a saved
 * item, the error, then its versions. Without `onSave` it closes a form: the save button submits it and the row is a
 * plain one.
 */
export function EditorActions({
  onSave,
  saveLabel,
  saveDisabled,
  onClose,
  onDelete,
  error,
  onDismissError,
  alert,
  errorRef,
  status,
  versions,
  children,
}: {
  /** Absent: the save button submits the form the footer ends. */
  onSave?: () => void;
  saveLabel?: ReactNode;
  saveDisabled?: boolean;
  /** Absent: no close button. */
  onClose?: () => void;
  /** Absent (an item not saved yet): no delete button. */
  onDelete?: () => void;
  error?: string;
  /** Given: a click on the error dismisses it. */
  onDismissError?: () => void;
  /** The error is announced at once (role alert); a form's always is. */
  alert?: boolean;
  errorRef?: Ref<HTMLSpanElement>;
  /** Shown before the error (a warning). */
  status?: ReactNode;
  /** Its versions, under the row. */
  versions?: ComponentProps<typeof Versions>;
  /** Beside the save button (save and play, duplicate…). */
  children?: ReactNode;
}): ReactElement {
  const t = useT();
  const form = !onSave;
  return (
    <>
      <div className={form ? "row" : "row actions"}>
        <button type={form ? "submit" : undefined} className="primary" disabled={saveDisabled} onClick={onSave}>
          {saveLabel ?? t.save}
        </button>
        {children}
        {onClose && (
          <button type={form ? "button" : undefined} className="ghost" onClick={() => onClose()}>
            {t.close}
          </button>
        )}
        {onDelete && (
          <button className="ghost danger" onClick={onDelete}>
            {t.delete}
          </button>
        )}
        {status}
        {error && (
          <span ref={errorRef} className="error" role={alert || form ? "alert" : undefined} onClick={onDismissError}>
            {error}
          </span>
        )}
      </div>
      {versions && <Versions {...versions} />}
    </>
  );
}
