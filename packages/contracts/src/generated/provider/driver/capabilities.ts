// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// What a driver offers a client: its models and modes, and the execution posture a run starts under.

/**
 * How a run may touch the machine, tagged on `mode`, the permission level: `readonly` and
 * `yolo` carry no writable roots, so only `ask`, `reviewed` and `sandboxed` name the folders a
 * run may write.
 */
export type ExecutionPosture =
  | {
      mode: "readonly";
      /**
       * The credential deny list handed to the provider on every level.
       */
      credentialPolicyRef: string;
      /**
       * Always empty.
       *
       * @maxItems 0
       */
      writableRoots: [];
    }
  | {
      mode: "ask";
      /**
       * The credential deny list handed to the provider on every level.
       */
      credentialPolicyRef: string;
      /**
       * The folders a run may write.
       */
      writableRoots: string[];
    }
  | {
      mode: "reviewed";
      /**
       * The credential deny list handed to the provider on every level.
       */
      credentialPolicyRef: string;
      /**
       * The folders a run may write.
       */
      writableRoots: string[];
    }
  | {
      mode: "sandboxed";
      /**
       * The credential deny list handed to the provider on every level.
       */
      credentialPolicyRef: string;
      /**
       * The folders a run may write.
       */
      writableRoots: string[];
    }
  | {
      mode: "yolo";
      /**
       * The credential deny list handed to the provider on every level.
       */
      credentialPolicyRef: string;
      /**
       * Always empty.
       *
       * @maxItems 0
       */
      writableRoots: [];
    };

/**
 * One selectable model of one provider, normalized at the driver's boundary. A model's default
 * row and its larger-window row share the model's id, so a row is found by its id and its
 * `largerWindow` together.
 */
export interface ProviderModel {
  /**
   * The model's id.
   */
  id: string;
  /**
   * The model's name.
   */
  name: string;
  /**
   * What the model can do, in the provider's words.
   */
  capabilities: string[];
  /**
   * The model's reasoning-effort levels, as the installed build offers them; absent means the
   * model has no effort axis, which an empty list would deny.
   */
  effortLevels?: string[];
  /**
   * The model's output-speed levels where its provider publishes them per model; absent means
   * the model exposes no speed selection.
   */
  outputSpeedLevels?: string[];
  /**
   * Whether the model has a fast output mode, as its provider reports it.
   */
  fast: boolean;
  /**
   * Whether this row is the model's larger window, offered beside its default row.
   */
  largerWindow: boolean;
  /**
   * The window in tokens as the provider reports it; absent until a reading arrives.
   */
  contextWindow?: number;
}
/**
 * One selectable mode of one provider, normalized at the driver's boundary.
 */
export interface ProviderMode {
  /**
   * The mode's id.
   */
  id: string;
  /**
   * The mode's name.
   */
  name: string;
}

export {
  validateExecutionPosture,
  validateProviderMode,
  validateProviderModel,
} from "../../checks/provider/driver/capabilities.js";
