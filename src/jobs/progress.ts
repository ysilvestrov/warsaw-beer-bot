export type ProgressFn = (text: string, opts?: { force?: boolean }) => Promise<void>;

export const noopProgress: ProgressFn = async () => {};
