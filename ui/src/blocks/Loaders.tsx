/**
 * Dot loader.
 * Rebuilt from the public listing of the bencho.dev "Dot loader" block. Not the
 * original source; swap for the original when available (see src/blocks/SOURCE.md).
 */
export function DotLoader({ label = "Loading" }: { label?: string }) {
  return (
    <span className="dots" role="status" aria-label={label}>
      <i />
      <i />
      <i />
    </span>
  );
}
