import { useCallback, useEffect, useRef, useState } from 'react';
import { UserAvatar } from '@/shared/components/UserAvatar';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Label } from '@/shared/ui/label';
import { errorMessageRu } from '@/shared/api/errors-ru';
import { notify } from '@/shared/lib/toast';
import {
  ACCEPTED_INPUT,
  decodeImageFile,
  filenameFor,
  ImageTooLargeError,
  releaseImage,
  renderAvatarBlob,
  sourceOf,
} from '../avatar-image';
import { DEFAULT_TRANSFORM, type CropSource, type CropTransform } from '../crop-geometry';
import { useRemoveAvatar, useUploadAvatar } from '../hooks';
import { SETTINGS_RU } from '../locale';
import { AvatarCropper, CROP_VIEWPORT } from './AvatarCropper';

const T = SETTINGS_RU.profile;

/**
 * The avatar control on «Профиль»: current photo, pick / replace / remove, and
 * a circular cropper before anything is uploaded.
 *
 * ## Why this is its own component
 *
 * It owns a decoded `HTMLImageElement`, an object URL, a crop transform, a
 * two-phase async operation and four error states. Inlining that into
 * `ProfilePage` would double the page's length and tangle it with the rest of
 * the form — which matters here because the avatar is saved on its own, not
 * with the form's «Сохранить». The upload endpoint is a separate request that
 * commits immediately, so pretending it is part of the dirty-field patch would
 * be a lie about what the button does.
 *
 * ## Honest states
 *
 * There is no percentage bar. The upload is one small request and the browser
 * gives `fetch` no upload progress, so a bar would either be fabricated or
 * would sit at 0 and jump to 100 — both worse than naming the phase we are
 * actually in. The two phases are real and distinguishable: «Готовим фото…»
 * (decode, crop, encode — the slow part on an old phone with a 12 MP photo) and
 * «Загружаем…» (the request).
 */
export function AvatarField(props: {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [source, setSource] = useState<CropSource | null>(null);
  const [transform, setTransform] = useState<CropTransform>(DEFAULT_TRANSFORM);
  const [preparing, setPreparing] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  const upload = useUploadAvatar();
  const remove = useRemoveAvatar();

  /**
   * Release the object URL when the cropper closes or the component unmounts.
   * A decoded 12 MP photo is ~48 MB of pixel data; leaking one per attempt is
   * how a settings screen ends up killing the tab on a phone.
   */
  const closeCropper = useCallback(() => {
    setImage((previous) => {
      releaseImage(previous);
      return null;
    });
    setSource(null);
    setTransform(DEFAULT_TRANSFORM);
  }, []);

  useEffect(
    () => () => {
      setImage((previous) => {
        releaseImage(previous);
        return null;
      });
    },
    [],
  );

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setPickError(null);
    setPreparing(true);
    try {
      const decoded = await decodeImageFile(file);
      setImage(decoded);
      setSource(sourceOf(decoded));
      // Fill the circle and centre it: a member who just taps «Сохранить»
      // still gets a reasonable crop.
      setTransform(DEFAULT_TRANSFORM);
    } catch (error) {
      setPickError(error instanceof ImageTooLargeError ? T.avatarTooLarge : T.avatarNotAnImage);
    } finally {
      setPreparing(false);
      // Reset the input, or picking the same file twice in a row fires no
      // `change` event and the button appears dead.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const save = async () => {
    if (!image || !source) return;
    setPickError(null);
    setPreparing(true);
    try {
      const encoded = await renderAvatarBlob(image, source, CROP_VIEWPORT, transform);
      setPreparing(false);
      await upload.mutateAsync({ blob: encoded.blob, filename: filenameFor(encoded.type) });
      notify.success(T.avatarSaved);
      closeCropper();
    } catch (error) {
      setPreparing(false);
      // A failure in `renderAvatarBlob` is a client problem with its own
      // sentence; a failure from the mutation is a server error and goes
      // through the Russian `ErrorCode` mapping, never through `error.message`.
      setPickError(upload.isError ? errorMessageRu(error) : T.avatarProcessFailed);
    }
  };

  const busy = preparing || upload.isPending;

  return (
    <div className="space-y-3">
      <Label htmlFor="avatar-file">{T.avatarLabel}</Label>

      <div className="flex items-center gap-4">
        <UserAvatar
          size="xl"
          user={{ id: props.userId, displayName: props.displayName, avatarUrl: props.avatarUrl }}
        />

        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={busy || remove.isPending}
              onClick={() => inputRef.current?.click()}
            >
              {props.avatarUrl ? T.avatarReplace : T.avatarAdd}
            </Button>

            {props.avatarUrl ? (
              <Button
                type="button"
                variant="ghost"
                className="h-11"
                disabled={busy || remove.isPending}
                onClick={() => {
                  remove.mutate(undefined, {
                    onSuccess: () => {
                      notify.success(T.avatarRemoved);
                    },
                    onError: (error) => {
                      notify.error(error);
                    },
                  });
                }}
              >
                {remove.isPending ? T.avatarRemoving : T.avatarRemove}
              </Button>
            ) : null}
          </div>

          <p className="text-xs text-muted-foreground">
            {props.avatarUrl ? T.avatarHint : T.avatarEmpty}
          </p>
        </div>
      </div>

      {pickError && !image ? (
        <p role="alert" className="text-xs text-destructive">
          {pickError}
        </p>
      ) : null}

      {/*
        Hidden, driven by the buttons above. A bare file input cannot be styled
        to match anything and reads terribly on a phone; the button carries the
        label and the accessible name.
      */}
      <input
        ref={inputRef}
        id="avatar-file"
        type="file"
        accept={ACCEPTED_INPUT}
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          void pick(event.target.files?.[0]);
        }}
      />

      <Dialog
        open={image !== null}
        onOpenChange={(open) => {
          if (!open && !busy) closeCropper();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{T.cropper.title}</DialogTitle>
            <DialogDescription>{T.cropper.description}</DialogDescription>
          </DialogHeader>

          {image && source ? (
            <AvatarCropper
              image={image}
              source={source}
              transform={transform}
              onChange={setTransform}
              disabled={busy}
            />
          ) : null}

          {pickError && image ? (
            <p role="alert" className="text-center text-xs text-destructive">
              {pickError}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="h-11"
              disabled={busy}
              onClick={closeCropper}
            >
              {T.cropper.cancel}
            </Button>
            <Button
              type="button"
              className="h-11"
              disabled={busy}
              onClick={() => {
                void save();
              }}
            >
              {preparing
                ? T.cropper.preparing
                : upload.isPending
                  ? T.cropper.uploading
                  : T.cropper.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
