/* tslint:disable */
/* eslint-disable */
/**
 * 
 * @export
 * @interface ActionOutcomePayload
 */
export interface ActionOutcomePayload {
    /**
     * 
     * @type {number}
     * @memberof ActionOutcomePayload
     */
    actionSeq: number;
    /**
     * 
     * @type {string}
     * @memberof ActionOutcomePayload
     */
    actionId: string;
    /**
     * 
     * @type {string}
     * @memberof ActionOutcomePayload
     */
    nodeId: string;
    /**
     * 
     * @type {string}
     * @memberof ActionOutcomePayload
     */
    conversationId: string;
    /**
     * 
     * @type {ActionOutcomeState}
     * @memberof ActionOutcomePayload
     */
    state: ActionOutcomeState;
    /**
     * 
     * @type {string}
     * @memberof ActionOutcomePayload
     */
    via?: ActionOutcomePayloadViaEnum;
    /**
     * 
     * @type {number}
     * @memberof ActionOutcomePayload
     */
    exitCode?: number | null;
    /**
     * 
     * @type {string}
     * @memberof ActionOutcomePayload
     */
    outputTail?: string;
    /**
     * 
     * @type {string}
     * @memberof ActionOutcomePayload
     */
    error?: string;
    /**
     * stop: every process it named had exited before the press reached it
     * @type {boolean}
     * @memberof ActionOutcomePayload
     */
    alreadyStopped?: boolean;
}


/**
 * @export
 */
export const ActionOutcomePayloadViaEnum = {
    Desktop: 'desktop',
    Remote: 'remote'
} as const;
export type ActionOutcomePayloadViaEnum = typeof ActionOutcomePayloadViaEnum[keyof typeof ActionOutcomePayloadViaEnum];


/**
 * 
 * @export
 */
export const ActionOutcomeState = {
    Pressed: 'pressed',
    Running: 'running',
    Succeeded: 'succeeded',
    Failed: 'failed',
    Stopped: 'stopped',
    Removed: 'removed',
    Dismissed: 'dismissed',
    Interrupted: 'interrupted'
} as const;
export type ActionOutcomeState = typeof ActionOutcomeState[keyof typeof ActionOutcomeState];

/**
 * 
 * @export
 * @interface ActionPressDto
 */
export interface ActionPressDto {
    /**
     * 
     * @type {ActionOutcomePayload}
     * @memberof ActionPressDto
     */
    outcome: ActionOutcomePayload;
}
/**
 * 
 * @export
 * @interface ActionPublisher
 */
export interface ActionPublisher {
    /**
     * 
     * @type {string}
     * @memberof ActionPublisher
     */
    nodeId: string;
    /**
     * 
     * @type {string}
     * @memberof ActionPublisher
     */
    conversationId: string;
    /**
     * 
     * @type {string}
     * @memberof ActionPublisher
     */
    callId?: string;
    /**
     * 
     * @type {string}
     * @memberof ActionPublisher
     */
    agentLabel?: string;
}
/**
 * 
 * @export
 * @interface ActionSpec
 */
export interface ActionSpec {
    /**
     * 
     * @type {string}
     * @memberof ActionSpec
     */
    kind: ActionSpecKindEnum;
    /**
     * message: what a press sends into the chat
     * @type {string}
     * @memberof ActionSpec
     */
    text?: string;
    /**
     * stop: the background command it was published against
     * @type {string}
     * @memberof ActionSpec
     */
    shellId?: string;
    /**
     * stop: the processes a press stops
     * @type {Array<ActionSpecTargetsInner>}
     * @memberof ActionSpec
     */
    targets?: Array<ActionSpecTargetsInner>;
    /**
     * command: never a shell line
     * @type {Array<string>}
     * @memberof ActionSpec
     */
    argv?: Array<string>;
    /**
     * 
     * @type {string}
     * @memberof ActionSpec
     */
    cwd?: string;
    /**
     * 
     * @type {number}
     * @memberof ActionSpec
     */
    timeoutMs?: number;
    /**
     * 
     * @type {boolean}
     * @memberof ActionSpec
     */
    notifyAgent?: boolean;
}


/**
 * @export
 */
export const ActionSpecKindEnum = {
    Message: 'message',
    Stop: 'stop',
    Command: 'command'
} as const;
export type ActionSpecKindEnum = typeof ActionSpecKindEnum[keyof typeof ActionSpecKindEnum];

/**
 * 
 * @export
 * @interface ActionSpecTargetsInner
 */
export interface ActionSpecTargetsInner {
    /**
     * 
     * @type {number}
     * @memberof ActionSpecTargetsInner
     */
    pid: number;
    /**
     * the start time recorded at publish, re-checked at press
     * @type {string}
     * @memberof ActionSpecTargetsInner
     */
    startedAt: string;
    /**
     * 
     * @type {string}
     * @memberof ActionSpecTargetsInner
     */
    command: string;
}
/**
 * 
 * @export
 * @interface ActiveSpan
 */
export interface ActiveSpan {
    /**
     * 
     * @type {number}
     * @memberof ActiveSpan
     */
    startMs: number;
    /**
     * 
     * @type {number}
     * @memberof ActiveSpan
     */
    endMs: number;
}
/**
 * 
 * @export
 * @interface ActiveTask
 */
export interface ActiveTask {
    /**
     * The task
     * @type {string}
     * @memberof ActiveTask
     */
    id: string;
    /**
     * The live run working it
     * @type {string}
     * @memberof ActiveTask
     */
    runId: string;
    /**
     * 
     * @type {AgentKind}
     * @memberof ActiveTask
     */
    agentKind: AgentKind | null;
}


/**
 * 
 * @export
 * @interface ActivityTotals
 */
export interface ActivityTotals {
    /**
     * threads (chats and team runs) created in the period
     * @type {number}
     * @memberof ActivityTotals
     */
    threadsCreated: number;
    /**
     * pull requests a thread opened in the period
     * @type {number}
     * @memberof ActivityTotals
     */
    pullRequests: number;
    /**
     * 
     * @type {number}
     * @memberof ActivityTotals
     */
    linesAdded: number | null;
    /**
     * 
     * @type {number}
     * @memberof ActivityTotals
     */
    linesRemoved: number | null;
    /**
     * true when a line figure is a lower bound: a listing was truncated, or some files were not counted
     * @type {boolean}
     * @memberof ActivityTotals
     */
    linesPartial: boolean;
    /**
     * threads that finished a turn in the period
     * @type {number}
     * @memberof ActivityTotals
     */
    activeThreads: number;
    /**
     * threads whose turns reported their working time
     * @type {number}
     * @memberof ActivityTotals
     */
    threadsWithWorkedTime: number;
    /**
     * 
     * @type {number}
     * @memberof ActivityTotals
     */
    avgWorkedMs: number | null;
}
/**
 * 
 * @export
 * @interface AddMcpServerDto
 */
export interface AddMcpServerDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof AddMcpServerDto
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AddMcpServerDto
     */
    configDir?: string;
    /**
     * 
     * @type {string}
     * @memberof AddMcpServerDto
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof AddMcpServerDto
     */
    transport: AddMcpServerDtoTransportEnum;
    /**
     * 
     * @type {string}
     * @memberof AddMcpServerDto
     */
    command?: string;
    /**
     * 
     * @type {Array<string>}
     * @memberof AddMcpServerDto
     */
    args?: Array<string>;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof AddMcpServerDto
     */
    env?: { [key: string]: string; };
    /**
     * 
     * @type {string}
     * @memberof AddMcpServerDto
     */
    url?: string;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof AddMcpServerDto
     */
    headers?: { [key: string]: string; };
}


/**
 * @export
 */
export const AddMcpServerDtoTransportEnum = {
    Stdio: 'stdio',
    Http: 'http'
} as const;
export type AddMcpServerDtoTransportEnum = typeof AddMcpServerDtoTransportEnum[keyof typeof AddMcpServerDtoTransportEnum];

/**
 * 
 * @export
 * @interface AddTaskAttachmentDto
 */
export interface AddTaskAttachmentDto {
    /**
     * 
     * @type {AttachmentMediaType}
     * @memberof AddTaskAttachmentDto
     */
    mediaType: AttachmentMediaType;
    /**
     * The image bytes, base64-encoded
     * @type {string}
     * @memberof AddTaskAttachmentDto
     */
    data: string;
    /**
     * The file’s own name, when the clipboard carried one
     * @type {string}
     * @memberof AddTaskAttachmentDto
     */
    name?: string;
}


/**
 * 
 * @export
 * @interface AgentActivityDto
 */
export interface AgentActivityDto {
    /**
     * Whether an agent is at work right now
     * @type {boolean}
     * @memberof AgentActivityDto
     */
    working: boolean;
}
/**
 * 
 * @export
 * @interface AgentApprovalCapability
 */
export interface AgentApprovalCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentApprovalCapability
     */
    agent: AgentKind;
    /**
     * Approval modes this CLI honours, in no particular order
     * @type {Array<ChatApprovalMode>}
     * @memberof AgentApprovalCapability
     */
    modes: Array<ChatApprovalMode>;
    /**
     * 
     * @type {AgentApprovalProbe}
     * @memberof AgentApprovalCapability
     */
    probe: AgentApprovalProbe | null;
}


/**
 * 
 * @export
 * @interface AgentApprovalProbe
 */
export interface AgentApprovalProbe {
    /**
     * One row per probed mode — `unknown` means not settled, never a fail
     * @type {Array<AgentApprovalProbeModesInner>}
     * @memberof AgentApprovalProbe
     */
    modes: Array<AgentApprovalProbeModesInner>;
    /**
     * 
     * @type {string}
     * @memberof AgentApprovalProbe
     */
    version: string | null;
    /**
     * 
     * @type {number}
     * @memberof AgentApprovalProbe
     */
    probedAt: number | null;
    /**
     * 
     * @type {string}
     * @memberof AgentApprovalProbe
     */
    reason: string | null;
}
/**
 * 
 * @export
 * @interface AgentApprovalProbeModesInner
 */
export interface AgentApprovalProbeModesInner {
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof AgentApprovalProbeModesInner
     */
    mode: ChatApprovalMode;
    /**
     * 
     * @type {ProbeStatus}
     * @memberof AgentApprovalProbeModesInner
     */
    status: ProbeStatus;
    /**
     * True when a client must not offer the mode until its probe passed — the daemon has no fallback to degrade it to
     * @type {boolean}
     * @memberof AgentApprovalProbeModesInner
     */
    requiresPass: boolean;
}


/**
 * 
 * @export
 * @interface AgentBackgroundWorkNote
 */
export interface AgentBackgroundWorkNote {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentBackgroundWorkNote
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentBackgroundWorkNote
     */
    note: string | null;
}


/**
 * 
 * @export
 * @interface AgentCacheResetDto
 */
export interface AgentCacheResetDto {
    /**
     * How many cached CLI answers were dropped.
     * @type {number}
     * @memberof AgentCacheResetDto
     */
    cleared: number;
}
/**
 * 
 * @export
 * @interface AgentConfigDirCapability
 */
export interface AgentConfigDirCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentConfigDirCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentConfigDirCapability
     */
    unavailableReason: string | null;
}


/**
 * 
 * @export
 * @interface AgentContextWindow
 */
export interface AgentContextWindow {
    /**
     * Passed verbatim to the CLI as that model's window setting
     * @type {string}
     * @memberof AgentContextWindow
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentContextWindow
     */
    label: string;
}
/**
 * 
 * @export
 * @interface AgentContextWindowListing
 */
export interface AgentContextWindowListing {
    /**
     * 
     * @type {Array<AgentContextWindow>}
     * @memberof AgentContextWindowListing
     */
    windows: Array<AgentContextWindow>;
    /**
     * 
     * @type {string}
     * @memberof AgentContextWindowListing
     */
    unavailableReason: string | null;
    /**
     * 
     * @type {AgentContextWindowUnavailableKind}
     * @memberof AgentContextWindowListing
     */
    unavailableKind: AgentContextWindowUnavailableKind | null;
}



/**
 * 
 * @export
 */
export const AgentContextWindowUnavailableKind = {
    NoModel: 'no-model',
    NoAxis: 'no-axis',
    FixedWindow: 'fixed-window',
    Unreadable: 'unreadable'
} as const;
export type AgentContextWindowUnavailableKind = typeof AgentContextWindowUnavailableKind[keyof typeof AgentContextWindowUnavailableKind];

/**
 * 
 * @export
 * @interface AgentCount
 */
export interface AgentCount {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentCount
     */
    kind: AgentKind;
    /**
     * 
     * @type {number}
     * @memberof AgentCount
     */
    count: number;
}


/**
 * 
 * @export
 * @interface AgentEffort
 */
export interface AgentEffort {
    /**
     * Passed verbatim to the CLI as `--effort <id>`
     * @type {string}
     * @memberof AgentEffort
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentEffort
     */
    label: string;
}
/**
 * 
 * @export
 * @interface AgentEffortListing
 */
export interface AgentEffortListing {
    /**
     * 
     * @type {Array<AgentEffort>}
     * @memberof AgentEffortListing
     */
    efforts: Array<AgentEffort>;
    /**
     * 
     * @type {string}
     * @memberof AgentEffortListing
     */
    unavailableReason: string | null;
}
/**
 * 
 * @export
 * @interface AgentFollowUpCapability
 */
export interface AgentFollowUpCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentFollowUpCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentFollowUpCapability
     */
    unavailableReason: string | null;
    /**
     * Whether a mid-turn message stops what the agent is doing
     * @type {boolean}
     * @memberof AgentFollowUpCapability
     */
    interrupts: boolean;
}



/**
 * 
 * @export
 */
export const AgentIconName = {
    Bot: 'bot',
    Terminal: 'terminal',
    Code: 'code'
} as const;
export type AgentIconName = typeof AgentIconName[keyof typeof AgentIconName];

/**
 * 
 * @export
 * @interface AgentIdentityCapability
 */
export interface AgentIdentityCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentIdentityCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentIdentityCapability
     */
    displayName: string;
    /**
     * 
     * @type {string}
     * @memberof AgentIdentityCapability
     */
    shortName: string;
    /**
     * 
     * @type {string}
     * @memberof AgentIdentityCapability
     */
    summary: string;
    /**
     * 
     * @type {Array<string>}
     * @memberof AgentIdentityCapability
     */
    details: Array<string>;
    /**
     * 
     * @type {AgentIconName}
     * @memberof AgentIdentityCapability
     */
    icon: AgentIconName;
    /**
     * 
     * @type {boolean}
     * @memberof AgentIdentityCapability
     */
    callerEscalatesQuestions: boolean;
    /**
     * 
     * @type {string}
     * @memberof AgentIdentityCapability
     */
    lightModel: string | null;
}


/**
 * 
 * @export
 * @interface AgentInstructionSize
 */
export interface AgentInstructionSize {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentInstructionSize
     */
    agent: AgentKind;
    /**
     * Length of the composed block, exactly
     * @type {number}
     * @memberof AgentInstructionSize
     */
    totalChars: number;
    /**
     * 
     * @type {number}
     * @memberof AgentInstructionSize
     */
    approxTokens: number;
    /**
     * The paragraph breaks between parts — totalChars less the parts
     * @type {number}
     * @memberof AgentInstructionSize
     */
    separatorChars: number;
    /**
     * 
     * @type {Array<InstructionSizePart>}
     * @memberof AgentInstructionSize
     */
    parts: Array<InstructionSizePart>;
}



/**
 * 
 * @export
 */
export const AgentKind = {
    Claude: 'claude',
    CursorAgent: 'cursor-agent',
    Codex: 'codex'
} as const;
export type AgentKind = typeof AgentKind[keyof typeof AgentKind];

/**
 * 
 * @export
 * @interface AgentMcpConfigDto
 */
export interface AgentMcpConfigDto {
    /**
     * 
     * @type {{ [key: string]: { [key: string]: any; }; }}
     * @memberof AgentMcpConfigDto
     */
    servers: { [key: string]: { [key: string]: any; }; } | null;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpConfigDto
     */
    path: string | null;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpConfigDto
     */
    version: string | null;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpConfigDto
     */
    unavailableReason: string | null;
}
/**
 * 
 * @export
 * @interface AgentMcpListingDto
 */
export interface AgentMcpListingDto {
    /**
     * 
     * @type {Array<AgentMcpServer>}
     * @memberof AgentMcpListingDto
     */
    servers: Array<AgentMcpServer>;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpListingDto
     */
    unavailableReason: string | null;
    /**
     * A cold read is running; these rows are not the answer yet. Ask again.
     * @type {boolean}
     * @memberof AgentMcpListingDto
     */
    pending: boolean;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpListingDto
     */
    interactiveOnlyNote: string | null;
    /**
     * The installed plugins behind that gap, each server copyable into the config the turns read
     * @type {Array<AgentMcpPlugin>}
     * @memberof AgentMcpListingDto
     */
    plugins: Array<AgentMcpPlugin>;
}
/**
 * 
 * @export
 * @interface AgentMcpPlugin
 */
export interface AgentMcpPlugin {
    /**
     * 
     * @type {string}
     * @memberof AgentMcpPlugin
     */
    name: string;
    /**
     * 
     * @type {boolean}
     * @memberof AgentMcpPlugin
     */
    enabledHere: boolean | null;
    /**
     * 
     * @type {Array<AgentMcpPluginServer>}
     * @memberof AgentMcpPlugin
     */
    servers: Array<AgentMcpPluginServer>;
    /**
     * 
     * @type {Array<AgentMcpPluginVariable>}
     * @memberof AgentMcpPlugin
     */
    variables: Array<AgentMcpPluginVariable>;
}
/**
 * 
 * @export
 * @interface AgentMcpPluginServer
 */
export interface AgentMcpPluginServer {
    /**
     * The name a copy is filed under
     * @type {string}
     * @memberof AgentMcpPluginServer
     */
    name: string;
    /**
     * What the CLI’s own app calls it — not a name its commands accept
     * @type {string}
     * @memberof AgentMcpPluginServer
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpPluginServer
     */
    transport: AgentMcpPluginServerTransportEnum | null;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpPluginServer
     */
    target: string | null;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpPluginServer
     */
    copiedAs: string | null;
}


/**
 * @export
 */
export const AgentMcpPluginServerTransportEnum = {
    Stdio: 'stdio',
    Http: 'http',
    Sse: 'sse'
} as const;
export type AgentMcpPluginServerTransportEnum = typeof AgentMcpPluginServerTransportEnum[keyof typeof AgentMcpPluginServerTransportEnum];

/**
 * 
 * @export
 * @interface AgentMcpPluginVariable
 */
export interface AgentMcpPluginVariable {
    /**
     * 
     * @type {string}
     * @memberof AgentMcpPluginVariable
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpPluginVariable
     */
    title: string | null;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpPluginVariable
     */
    description: string | null;
    /**
     * 
     * @type {Array<string>}
     * @memberof AgentMcpPluginVariable
     */
    options: Array<string> | null;
    /**
     * 
     * @type {boolean}
     * @memberof AgentMcpPluginVariable
     */
    required: boolean;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpPluginVariable
     */
    defaultValue: string | null;
}
/**
 * 
 * @export
 * @interface AgentMcpServer
 */
export interface AgentMcpServer {
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    target: string | null;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    transport: AgentMcpServerTransportEnum | null;
    /**
     * Health as the CLI reported it; `pending` is a configured but unapproved server, `loading` one the CLI was still dialling when it answered, `disabled` one switched off in the CLI’s own config, `needs_auth` an OAuth server nobody has signed in to yet
     * @type {string}
     * @memberof AgentMcpServer
     */
    status: AgentMcpServerStatusEnum;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    detail: string | null;
    /**
     * Which of the CLI’s configuration scopes defined this server; `unknown` when the CLI’s files could not place it
     * @type {string}
     * @memberof AgentMcpServer
     */
    scope: AgentMcpServerScopeEnum;
    /**
     * True when this WORKSPACE definition overrides a same-named user one, so the user’s own server is not what this folder loads under that name
     * @type {boolean}
     * @memberof AgentMcpServer
     */
    shadowsUser: boolean;
    /**
     * Whether the next turn will leave this server out, whoever switched it off
     * @type {boolean}
     * @memberof AgentMcpServer
     */
    disabled: boolean;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    toggleUnavailableReason: string | null;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    turnToggleUnavailableReason?: string | null;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    signInUnavailableReason: string | null;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    approveUnavailableReason: string | null;
    /**
     * 
     * @type {number}
     * @memberof AgentMcpServer
     */
    toolCount?: number | null;
    /**
     * 
     * @type {string}
     * @memberof AgentMcpServer
     */
    plugin?: string | null;
}


/**
 * @export
 */
export const AgentMcpServerTransportEnum = {
    Stdio: 'stdio',
    Http: 'http',
    Sse: 'sse'
} as const;
export type AgentMcpServerTransportEnum = typeof AgentMcpServerTransportEnum[keyof typeof AgentMcpServerTransportEnum];

/**
 * @export
 */
export const AgentMcpServerStatusEnum = {
    Connected: 'connected',
    Failed: 'failed',
    Pending: 'pending',
    Loading: 'loading',
    Disabled: 'disabled',
    NeedsAuth: 'needs_auth',
    Unknown: 'unknown'
} as const;
export type AgentMcpServerStatusEnum = typeof AgentMcpServerStatusEnum[keyof typeof AgentMcpServerStatusEnum];

/**
 * @export
 */
export const AgentMcpServerScopeEnum = {
    User: 'user',
    Workspace: 'workspace',
    Unknown: 'unknown'
} as const;
export type AgentMcpServerScopeEnum = typeof AgentMcpServerScopeEnum[keyof typeof AgentMcpServerScopeEnum];

/**
 * 
 * @export
 * @interface AgentModel
 */
export interface AgentModel {
    /**
     * Model identifier; ollama/ prefixes select a local provider
     * @type {string}
     * @memberof AgentModel
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentModel
     */
    label: string;
    /**
     * The model id this alias runs as
     * @type {string}
     * @memberof AgentModel
     */
    resolvedModel?: string;
    /**
     * Known default context window in tokens; omitted when unknown
     * @type {number}
     * @memberof AgentModel
     */
    contextTokens?: number;
    /**
     * The agent exposes a separate per-model context-window selector
     * @type {boolean}
     * @memberof AgentModel
     */
    contextWindowSelectable?: boolean;
    /**
     * Reported by the CLI, a documented fallback, or local Ollama
     * @type {string}
     * @memberof AgentModel
     */
    source: AgentModelSourceEnum;
    /**
     * Why this model cannot run an agent
     * @type {string}
     * @memberof AgentModel
     */
    unavailableReason?: string;
}


/**
 * @export
 */
export const AgentModelSourceEnum = {
    Cli: 'cli',
    Builtin: 'builtin',
    Ollama: 'ollama'
} as const;
export type AgentModelSourceEnum = typeof AgentModelSourceEnum[keyof typeof AgentModelSourceEnum];

/**
 * 
 * @export
 * @interface AgentModelEffortCapability
 */
export interface AgentModelEffortCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentModelEffortCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentModelEffortCapability
     */
    unavailableReason: string | null;
}


/**
 * 
 * @export
 * @interface AgentModelParameter
 */
export interface AgentModelParameter {
    /**
     * The CLI’s own parameter id, sent back verbatim
     * @type {string}
     * @memberof AgentModelParameter
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentModelParameter
     */
    label: string;
    /**
     * 
     * @type {Array<AgentModelParameterValue>}
     * @memberof AgentModelParameter
     */
    values: Array<AgentModelParameterValue>;
    /**
     * 
     * @type {string}
     * @memberof AgentModelParameter
     */
    current: string | null;
}
/**
 * 
 * @export
 * @interface AgentModelParameterListing
 */
export interface AgentModelParameterListing {
    /**
     * 
     * @type {Array<AgentModelParameter>}
     * @memberof AgentModelParameterListing
     */
    parameters: Array<AgentModelParameter>;
    /**
     * 
     * @type {string}
     * @memberof AgentModelParameterListing
     */
    unavailableReason: string | null;
}
/**
 * 
 * @export
 * @interface AgentModelParameterValue
 */
export interface AgentModelParameterValue {
    /**
     * Passed verbatim to the CLI as this parameter’s value
     * @type {string}
     * @memberof AgentModelParameterValue
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentModelParameterValue
     */
    label: string;
    /**
     * What picking it does, in the CLI’s own words
     * @type {string}
     * @memberof AgentModelParameterValue
     */
    description?: string;
}
/**
 * 
 * @export
 * @interface AgentOptionSpec
 */
export interface AgentOptionSpec {
    /**
     * 
     * @type {string}
     * @memberof AgentOptionSpec
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentOptionSpec
     */
    label: string;
    /**
     * 
     * @type {string}
     * @memberof AgentOptionSpec
     */
    description: string;
    /**
     * 
     * @type {boolean}
     * @memberof AgentOptionSpec
     */
    defaultValue: boolean;
}
/**
 * 
 * @export
 * @interface AgentOptionsCapability
 */
export interface AgentOptionsCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentOptionsCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {Array<AgentOptionSpec>}
     * @memberof AgentOptionsCapability
     */
    options: Array<AgentOptionSpec>;
}


/**
 * 
 * @export
 * @interface AgentSession
 */
export interface AgentSession {
    /**
     * The id the CLI resumes by
     * @type {string}
     * @memberof AgentSession
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof AgentSession
     */
    cwd: string | null;
    /**
     * 
     * @type {string}
     * @memberof AgentSession
     */
    title: string | null;
    /**
     * 
     * @type {number}
     * @memberof AgentSession
     */
    updatedAt: number | null;
    /**
     * 
     * @type {string}
     * @memberof AgentSession
     */
    snippet: string | null;
}
/**
 * 
 * @export
 * @interface AgentSessionListingDto
 */
export interface AgentSessionListingDto {
    /**
     * 
     * @type {Array<AgentSession>}
     * @memberof AgentSessionListingDto
     */
    sessions: Array<AgentSession>;
    /**
     * 
     * @type {string}
     * @memberof AgentSessionListingDto
     */
    unavailableReason: string | null;
    /**
     * 
     * @type {string}
     * @memberof AgentSessionListingDto
     */
    partialReason: string | null;
}
/**
 * 
 * @export
 * @interface AgentSkillDto
 */
export interface AgentSkillDto {
    /**
     * 
     * @type {string}
     * @memberof AgentSkillDto
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof AgentSkillDto
     */
    description: string | null;
    /**
     * A skill directory (SKILL.md) vs a plain command file
     * @type {string}
     * @memberof AgentSkillDto
     */
    kind: AgentSkillDtoKindEnum;
    /**
     * Where it came from — this app itself, a disk scan, or the CLI session
     * @type {string}
     * @memberof AgentSkillDto
     */
    source: AgentSkillDtoSourceEnum;
}


/**
 * @export
 */
export const AgentSkillDtoKindEnum = {
    Skill: 'skill',
    Command: 'command'
} as const;
export type AgentSkillDtoKindEnum = typeof AgentSkillDtoKindEnum[keyof typeof AgentSkillDtoKindEnum];

/**
 * @export
 */
export const AgentSkillDtoSourceEnum = {
    Geniro: 'geniro',
    Project: 'project',
    User: 'user',
    Cli: 'cli'
} as const;
export type AgentSkillDtoSourceEnum = typeof AgentSkillDtoSourceEnum[keyof typeof AgentSkillDtoSourceEnum];

/**
 * 
 * @export
 * @interface AgentSubagentCapability
 */
export interface AgentSubagentCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentSubagentCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentSubagentCapability
     */
    unavailableReason: string | null;
}


/**
 * 
 * @export
 * @interface AgentTerminalCapability
 */
export interface AgentTerminalCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentTerminalCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentTerminalCapability
     */
    unavailableReason: string | null;
}


/**
 * 
 * @export
 * @interface AgentUsageCapability
 */
export interface AgentUsageCapability {
    /**
     * 
     * @type {AgentKind}
     * @memberof AgentUsageCapability
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof AgentUsageCapability
     */
    unavailableReason: string | null;
}


/**
 * 
 * @export
 * @interface AgentVocabularyDto
 */
export interface AgentVocabularyDto {
    /**
     * 
     * @type {Array<AgentModel>}
     * @memberof AgentVocabularyDto
     */
    models: Array<AgentModel> | null;
    /**
     * 
     * @type {AgentEffortListing}
     * @memberof AgentVocabularyDto
     */
    efforts: AgentEffortListing | null;
    /**
     * 
     * @type {AgentContextWindowListing}
     * @memberof AgentVocabularyDto
     */
    contextWindows: AgentContextWindowListing | null;
    /**
     * 
     * @type {AgentModelParameterListing}
     * @memberof AgentVocabularyDto
     */
    modelParameters: AgentModelParameterListing | null;
}
/**
 * 
 * @export
 * @interface AnalysisJudgeCheckDto
 */
export interface AnalysisJudgeCheckDto {
    /**
     * 
     * @type {string}
     * @memberof AnalysisJudgeCheckDto
     */
    judgeVendor: string | null;
    /**
     * members of the team
     * @type {number}
     * @memberof AnalysisJudgeCheckDto
     */
    members: number;
    /**
     * the members whose own model is the judge’s vendor
     * @type {Array<string>}
     * @memberof AnalysisJudgeCheckDto
     */
    sameVendor: Array<string>;
    /**
     * agents whose every model is another vendor’s
     * @type {Array<AgentKind>}
     * @memberof AnalysisJudgeCheckDto
     */
    alternatives: Array<AgentKind>;
}
/**
 * 
 * @export
 * @interface AnalyzeTeamDto
 */
export interface AnalyzeTeamDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof AnalyzeTeamDto
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof AnalyzeTeamDto
     */
    approval?: ChatApprovalMode;
    /**
     * 
     * @type {string}
     * @memberof AnalyzeTeamDto
     */
    model?: string;
    /**
     * 
     * @type {string}
     * @memberof AnalyzeTeamDto
     */
    effort?: string;
    /**
     * 
     * @type {string}
     * @memberof AnalyzeTeamDto
     */
    contextWindow?: string;
    /**
     * 
     * @type {number}
     * @memberof AnalyzeTeamDto
     */
    autoCompactPercent?: number;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof AnalyzeTeamDto
     */
    modelParameters?: { [key: string]: string; };
    /**
     * 
     * @type {string}
     * @memberof AnalyzeTeamDto
     */
    configDir?: string;
    /**
     * 
     * @type {string}
     * @memberof AnalyzeTeamDto
     */
    cwd?: string;
    /**
     * The user's focus or extra instructions for this analysis
     * @type {string}
     * @memberof AnalyzeTeamDto
     */
    focus?: string;
    /**
     * 
     * @type {string}
     * @memberof AnalyzeTeamDto
     */
    customInstructions?: string;
    /**
     * 
     * @type {string}
     * @memberof AnalyzeTeamDto
     */
    replyLanguage?: string;
    /**
     * 
     * @type {{ [key: string]: { [key: string]: boolean; }; }}
     * @memberof AnalyzeTeamDto
     */
    agentOptions?: { [key: string]: { [key: string]: boolean; }; };
    /**
     * How many of the team's newest runs to read
     * @type {number}
     * @memberof AnalyzeTeamDto
     */
    runs: number;
}


/**
 * 
 * @export
 * @interface AnalyzeThreadDto
 */
export interface AnalyzeThreadDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof AnalyzeThreadDto
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof AnalyzeThreadDto
     */
    approval?: ChatApprovalMode;
    /**
     * 
     * @type {string}
     * @memberof AnalyzeThreadDto
     */
    model?: string;
    /**
     * 
     * @type {string}
     * @memberof AnalyzeThreadDto
     */
    effort?: string;
    /**
     * 
     * @type {string}
     * @memberof AnalyzeThreadDto
     */
    contextWindow?: string;
    /**
     * 
     * @type {number}
     * @memberof AnalyzeThreadDto
     */
    autoCompactPercent?: number;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof AnalyzeThreadDto
     */
    modelParameters?: { [key: string]: string; };
    /**
     * 
     * @type {string}
     * @memberof AnalyzeThreadDto
     */
    configDir?: string;
    /**
     * 
     * @type {string}
     * @memberof AnalyzeThreadDto
     */
    cwd?: string;
    /**
     * The user's focus or extra instructions for this analysis
     * @type {string}
     * @memberof AnalyzeThreadDto
     */
    focus?: string;
    /**
     * 
     * @type {string}
     * @memberof AnalyzeThreadDto
     */
    customInstructions?: string;
    /**
     * 
     * @type {string}
     * @memberof AnalyzeThreadDto
     */
    replyLanguage?: string;
    /**
     * 
     * @type {{ [key: string]: { [key: string]: boolean; }; }}
     * @memberof AnalyzeThreadDto
     */
    agentOptions?: { [key: string]: { [key: string]: boolean; }; };
}


/**
 * 
 * @export
 * @interface AppProcessThread
 */
export interface AppProcessThread {
    /**
     * 
     * @type {string}
     * @memberof AppProcessThread
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof AppProcessThread
     */
    title: string | null;
    /**
     * the CLIs this thread is running, one entry per CLI
     * @type {Array<AgentKind>}
     * @memberof AppProcessThread
     */
    agentKinds: Array<AgentKind>;
    /**
     * how many agent processes it keeps — several for a team
     * @type {number}
     * @memberof AppProcessThread
     */
    agents: number;
    /**
     * how many of its processes no agent CLI of it holds — left running detached; counted in `figures`
     * @type {number}
     * @memberof AppProcessThread
     */
    detachedProcesses: number;
    /**
     * 
     * @type {ProcessFigures}
     * @memberof AppProcessThread
     */
    figures: ProcessFigures;
}
/**
 * 
 * @export
 * @interface AppProcessesDto
 */
export interface AppProcessesDto {
    /**
     * 
     * @type {string}
     * @memberof AppProcessesDto
     */
    sampledAt: string;
    /**
     * heaviest first, by resident memory
     * @type {Array<AppProcessThread>}
     * @memberof AppProcessesDto
     */
    threads: Array<AppProcessThread>;
    /**
     * 
     * @type {ProcessFigures}
     * @memberof AppProcessesDto
     */
    geniro: ProcessFigures | null;
    /**
     * 
     * @type {ProcessFigures}
     * @memberof AppProcessesDto
     */
    leftover: ProcessFigures | null;
    /**
     * 
     * @type {ProcessFigures}
     * @memberof AppProcessesDto
     */
    total: ProcessFigures;
    /**
     * 
     * @type {string}
     * @memberof AppProcessesDto
     */
    unavailableReason: string | null;
}
/**
 * 
 * @export
 * @interface ApplyRecommendationsDto
 */
export interface ApplyRecommendationsDto {
    /**
     * 
     * @type {number}
     * @memberof ApplyRecommendationsDto
     */
    cardSeq: number;
    /**
     * 
     * @type {Array<string>}
     * @memberof ApplyRecommendationsDto
     */
    ids: Array<string>;
    /**
     * 
     * @type {string}
     * @memberof ApplyRecommendationsDto
     */
    note?: string;
    /**
     * ID generated once per press and reused for retries
     * @type {string}
     * @memberof ApplyRecommendationsDto
     */
    clientMessageId: string;
}

/**
 * 
 * @export
 */
export const ApprovalMode = {
    Auto: 'auto',
    Ask: 'ask',
    AcceptEdits: 'acceptEdits'
} as const;
export type ApprovalMode = typeof ApprovalMode[keyof typeof ApprovalMode];

/**
 * 
 * @export
 * @interface ArtifactAnswersDto
 */
export interface ArtifactAnswersDto {
    /**
     * each answer by the name the page saved it under
     * @type {{ [key: string]: any; }}
     * @memberof ArtifactAnswersDto
     */
    values: { [key: string]: any; };
    /**
     * 
     * @type {string}
     * @memberof ArtifactAnswersDto
     */
    updatedAt: string | null;
}
/**
 * 
 * @export
 * @interface AttachTaskFileDto
 */
export interface AttachTaskFileDto {
    /**
     * An absolute path on this machine
     * @type {string}
     * @memberof AttachTaskFileDto
     */
    path: string;
}
/**
 * 
 * @export
 * @interface AttachmentDataDto
 */
export interface AttachmentDataDto {
    /**
     * 
     * @type {string}
     * @memberof AttachmentDataDto
     */
    id: string;
    /**
     * 
     * @type {AttachmentMediaType}
     * @memberof AttachmentDataDto
     */
    mediaType: AttachmentMediaType;
    /**
     * base64-encoded image bytes
     * @type {string}
     * @memberof AttachmentDataDto
     */
    data: string;
}



/**
 * 
 * @export
 */
export const AttachmentMediaType = {
    ImagePng: 'image/png',
    ImageJpeg: 'image/jpeg',
    ImageGif: 'image/gif',
    ImageWebp: 'image/webp'
} as const;
export type AttachmentMediaType = typeof AttachmentMediaType[keyof typeof AttachmentMediaType];

/**
 * 
 * @export
 * @interface BlockedTask
 */
export interface BlockedTask {
    /**
     * 
     * @type {string}
     * @memberof BlockedTask
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof BlockedTask
     */
    title: string;
    /**
     * Why this card cannot start, in words a user can act on
     * @type {string}
     * @memberof BlockedTask
     */
    reason: string;
    /**
     * Where the answer lies: the run settings (run-target, missing-team), a Run press on the card itself (stopped, worktree), or the project's overrides on the team's page (overlay)
     * @type {BlockedTaskKind}
     * @memberof BlockedTask
     */
    kind: BlockedTaskKind;
    /**
     * 
     * @type {number}
     * @memberof BlockedTask
     */
    retryInMs: number | null;
}



/**
 * 
 * @export
 */
export const BlockedTaskKind = {
    RunTarget: 'run-target',
    MissingTeam: 'missing-team',
    Stopped: 'stopped',
    Worktree: 'worktree',
    Overlay: 'overlay'
} as const;
export type BlockedTaskKind = typeof BlockedTaskKind[keyof typeof BlockedTaskKind];

/**
 * 
 * @export
 * @interface CallClock
 */
export interface CallClock {
    /**
     * 
     * @type {number}
     * @memberof CallClock
     */
    closedMs: number;
    /**
     * 
     * @type {number}
     * @memberof CallClock
     */
    runningSince: number | null;
    /**
     * 
     * @type {number}
     * @memberof CallClock
     */
    parkedMs: number;
    /**
     * 
     * @type {number}
     * @memberof CallClock
     */
    parkedSince: number | null;
    /**
     * 
     * @type {Array<string>}
     * @memberof CallClock
     */
    openCards: Array<string>;
    /**
     * 
     * @type {number}
     * @memberof CallClock
     */
    throughSeq: number;
}
/**
 * 
 * @export
 * @interface CallContextReading
 */
export interface CallContextReading {
    /**
     * 
     * @type {string}
     * @memberof CallContextReading
     */
    callId: string;
    /**
     * 
     * @type {number}
     * @memberof CallContextReading
     */
    contextTokens: number | null;
    /**
     * Whether contextTokens is geniro's stand-in for an occupancy the CLI did not state; false when the CLI stated it
     * @type {boolean}
     * @memberof CallContextReading
     */
    contextEstimated: boolean;
    /**
     * 
     * @type {number}
     * @memberof CallContextReading
     */
    contextWindowTokens: number | null;
    /**
     * 
     * @type {CallStartReading}
     * @memberof CallContextReading
     */
    start: CallStartReading | null;
}
/**
 * 
 * @export
 * @interface CallFigures
 */
export interface CallFigures {
    /**
     * 
     * @type {string}
     * @memberof CallFigures
     */
    callId: string;
    /**
     * 
     * @type {ChatTotals}
     * @memberof CallFigures
     */
    totals: ChatTotals;
    /**
     * 
     * @type {CallClock}
     * @memberof CallFigures
     */
    clock: CallClock | null;
    /**
     * The tools the node itself called inside this call, its CLI sub-agents' excluded, counted from the transcript as of toolCallsThroughSeq
     * @type {number}
     * @memberof CallFigures
     */
    toolCalls: number;
    /**
     * 
     * @type {number}
     * @memberof CallFigures
     */
    toolCallsThroughSeq: number | null;
    /**
     * 
     * @type {string}
     * @memberof CallFigures
     */
    promptCacheExpiresAt: string | null;
}
/**
 * 
 * @export
 * @interface CallMessagesDto
 */
export interface CallMessagesDto {
    /**
     * The newest messages the callee itself wrote, in seq order
     * @type {Array<ChatHistoryDtoItemsInner>}
     * @memberof CallMessagesDto
     */
    messages: Array<ChatHistoryDtoItemsInner>;
    /**
     * Whether the callee wrote more messages than these
     * @type {boolean}
     * @memberof CallMessagesDto
     */
    hasOlder: boolean;
}
/**
 * 
 * @export
 * @interface CallStartReading
 */
export interface CallStartReading {
    /**
     * 
     * @type {string}
     * @memberof CallStartReading
     */
    callerMemberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof CallStartReading
     */
    title: string | null;
    /**
     * 
     * @type {string}
     * @memberof CallStartReading
     */
    message: string | null;
    /**
     * 
     * @type {string}
     * @memberof CallStartReading
     */
    mode: string | null;
    /**
     * 
     * @type {string}
     * @memberof CallStartReading
     */
    thread: string | null;
    /**
     * 
     * @type {number}
     * @memberof CallStartReading
     */
    startedAt: number | null;
}
/**
 * 
 * @export
 * @interface CancelledDto
 */
export interface CancelledDto {
    /**
     * True when a live turn was signalled to stop
     * @type {boolean}
     * @memberof CancelledDto
     */
    cancelled: boolean;
}
/**
 * 
 * @export
 * @interface CapabilitiesDto
 */
export interface CapabilitiesDto {
    /**
     * Every registered CLI, in registration order, with how the UI names it
     * @type {Array<AgentIdentityCapability>}
     * @memberof CapabilitiesDto
     */
    agents: Array<AgentIdentityCapability>;
    /**
     * Per-CLI config-directory (profile / account) support, one entry per known agent
     * @type {Array<AgentConfigDirCapability>}
     * @memberof CapabilitiesDto
     */
    configDirs: Array<AgentConfigDirCapability>;
    /**
     * Per-CLI interactive terminal-mirror support, one entry per known agent
     * @type {Array<AgentTerminalCapability>}
     * @memberof CapabilitiesDto
     */
    interactiveTerminals: Array<AgentTerminalCapability>;
    /**
     * Per-CLI tool-approval modes, one entry per known agent
     * @type {Array<AgentApprovalCapability>}
     * @memberof CapabilitiesDto
     */
    approvals: Array<AgentApprovalCapability>;
    /**
     * Per-CLI mid-turn follow-up support, one entry per known agent
     * @type {Array<AgentFollowUpCapability>}
     * @memberof CapabilitiesDto
     */
    followUps: Array<AgentFollowUpCapability>;
    /**
     * Per-CLI background sub-agent reporting, one entry per known agent
     * @type {Array<AgentSubagentCapability>}
     * @memberof CapabilitiesDto
     */
    subagents: Array<AgentSubagentCapability>;
    /**
     * Per-CLI token/cost usage reporting, one entry per known agent
     * @type {Array<AgentUsageCapability>}
     * @memberof CapabilitiesDto
     */
    usage: Array<AgentUsageCapability>;
    /**
     * Per-CLI reasoning-effort picker support, one entry per known agent
     * @type {Array<AgentModelEffortCapability>}
     * @memberof CapabilitiesDto
     */
    modelEfforts: Array<AgentModelEffortCapability>;
    /**
     * Per-CLI user switches, one entry per known agent
     * @type {Array<AgentOptionsCapability>}
     * @memberof CapabilitiesDto
     */
    options: Array<AgentOptionsCapability>;
    /**
     * The instruction block geniro prepends to every user-facing turn, before the user’s own custom instructions
     * @type {string}
     * @memberof CapabilitiesDto
     */
    hostPreamble: string;
    /**
     * Per-CLI note on background work, composed right after the host preamble, one entry per known agent
     * @type {Array<AgentBackgroundWorkNote>}
     * @memberof CapabilitiesDto
     */
    backgroundWorkNotes: Array<AgentBackgroundWorkNote>;
    /**
     * The machine ceiling on callee turns working at once in one run (sized from total memory)
     * @type {number}
     * @memberof CapabilitiesDto
     */
    maxActiveTurnsCeiling: number;
}
/**
 * 
 * @export
 * @interface CardAssessmentVerdictsDto
 */
export interface CardAssessmentVerdictsDto {
    /**
     * 
     * @type {Array<CardAssessmentVerdictsDtoVerdictsInner>}
     * @memberof CardAssessmentVerdictsDto
     */
    verdicts: Array<CardAssessmentVerdictsDtoVerdictsInner>;
}
/**
 * 
 * @export
 * @interface CardAssessmentVerdictsDtoVerdictsInner
 */
export interface CardAssessmentVerdictsDtoVerdictsInner {
    /**
     * 
     * @type {string}
     * @memberof CardAssessmentVerdictsDtoVerdictsInner
     */
    memberId: string;
    /**
     * 
     * @type {MemberAssessmentUserVerdict}
     * @memberof CardAssessmentVerdictsDtoVerdictsInner
     */
    userVerdict: MemberAssessmentUserVerdict | null;
}

/**
 * 
 * @export
 */
export const ChatApprovalMode = {
    Auto: 'auto',
    Ask: 'ask',
    AcceptEdits: 'acceptEdits',
    Plan: 'plan'
} as const;
export type ChatApprovalMode = typeof ChatApprovalMode[keyof typeof ChatApprovalMode];

/**
 * 
 * @export
 * @interface ChatDeletedDto
 */
export interface ChatDeletedDto {
    /**
     * True when the chat and everything it owned were removed
     * @type {boolean}
     * @memberof ChatDeletedDto
     */
    deleted: boolean;
}
/**
 * 
 * @export
 * @interface ChatExportDto
 */
export interface ChatExportDto {
    /**
     * Shape of this document — see CHAT_EXPORT_FORMAT_VERSION
     * @type {number}
     * @memberof ChatExportDto
     */
    formatVersion: number;
    /**
     * 
     * @type {string}
     * @memberof ChatExportDto
     */
    exportedAt: string;
    /**
     * The daemon build that wrote this file, for a bug report
     * @type {string}
     * @memberof ChatExportDto
     */
    daemonVersion: string;
    /**
     * 
     * @type {ChatExportRun}
     * @memberof ChatExportDto
     */
    run: ChatExportRun;
    /**
     * 
     * @type {ChatTotals}
     * @memberof ChatExportDto
     */
    totals: ChatTotals;
    /**
     * 
     * @type {Array<ChatExportNode>}
     * @memberof ChatExportDto
     */
    nodes: Array<ChatExportNode>;
    /**
     * The COMPLETE transcript in seq order — payloads parsed back from their stored JSON, so a tool_call and its tool_result survive verbatim
     * @type {Array<ChatHistoryDtoItemsInner>}
     * @memberof ChatExportDto
     */
    items: Array<ChatHistoryDtoItemsInner>;
}
/**
 * 
 * @export
 * @interface ChatExportNode
 */
export interface ChatExportNode {
    /**
     * 
     * @type {string}
     * @memberof ChatExportNode
     */
    memberId: string;
    /**
     * 
     * @type {string}
     * @memberof ChatExportNode
     */
    status: string;
    /**
     * 
     * @type {AgentKind}
     * @memberof ChatExportNode
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportNode
     */
    model: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportNode
     */
    agentSessionId: string | null;
    /**
     * 
     * @type {number}
     * @memberof ChatExportNode
     */
    startedAt: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatExportNode
     */
    endedAt: number | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportNode
     */
    error: string | null;
}


/**
 * 
 * @export
 * @interface ChatExportRun
 */
export interface ChatExportRun {
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    teamId: string | null;
    /**
     * 
     * @type {RunStatus}
     * @memberof ChatExportRun
     */
    status: RunStatus;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    title: string | null;
    /**
     * 
     * @type {AgentKind}
     * @memberof ChatExportRun
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    cwd: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    startSha: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof ChatExportRun
     */
    startDirty: boolean | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    model: string | null;
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof ChatExportRun
     */
    approval: ChatApprovalMode | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    effort: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    contextWindow: string | null;
    /**
     * 
     * @type {number}
     * @memberof ChatExportRun
     */
    autoCompactPercent: number | null;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof ChatExportRun
     */
    modelParameters: { [key: string]: string; };
    /**
     * 
     * @type {number}
     * @memberof ChatExportRun
     */
    contextTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatExportRun
     */
    contextWindowTokens: number | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    configDir: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    groupId: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    customInstructions: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    replyLanguage: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    taskInstructions: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    teamInstructions: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    projectInstructions: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    memoryIndex: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    knowledgeIndex: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof ChatExportRun
     */
    nativeMemoryOff: boolean | null;
    /**
     * 
     * @type {{ [key: string]: { [key: string]: boolean; }; }}
     * @memberof ChatExportRun
     */
    agentOptions: { [key: string]: { [key: string]: boolean; }; } | null;
    /**
     * 
     * @type {any}
     * @memberof ChatExportRun
     */
    lastMetricsReading: any | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    pendingContext: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof ChatExportRun
     */
    updatedAt: string;
}


/**
 * 
 * @export
 * @interface ChatHistoryDto
 */
export interface ChatHistoryDto {
    /**
     * The page, in seq order — what the window holds
     * @type {Array<ChatHistoryDtoItemsInner>}
     * @memberof ChatHistoryDto
     */
    items: Array<ChatHistoryDtoItemsInner>;
    /**
     * Rows outside the page its rows refer to, in seq order — never part of the window
     * @type {Array<ChatHistoryDtoItemsInner>}
     * @memberof ChatHistoryDto
     */
    anchors: Array<ChatHistoryDtoItemsInner>;
}
/**
 * 
 * @export
 * @interface ChatHistoryDtoItemsInner
 */
export interface ChatHistoryDtoItemsInner {
    /**
     * 
     * @type {string}
     * @memberof ChatHistoryDtoItemsInner
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof ChatHistoryDtoItemsInner
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof ChatHistoryDtoItemsInner
     */
    memberId: string | null;
    /**
     * Monotonic per-run sequence — the replay cursor
     * @type {number}
     * @memberof ChatHistoryDtoItemsInner
     */
    seq: number;
    /**
     * 
     * @type {ItemKind}
     * @memberof ChatHistoryDtoItemsInner
     */
    kind: ItemKind;
    /**
     * 
     * @type {string}
     * @memberof ChatHistoryDtoItemsInner
     */
    role: string | null;
    /**
     * 
     * @type {any}
     * @memberof ChatHistoryDtoItemsInner
     */
    payload: any | null;
    /**
     * 
     * @type {string}
     * @memberof ChatHistoryDtoItemsInner
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof ChatHistoryDtoItemsInner
     */
    inCall?: string | null;
}


/**
 * 
 * @export
 * @interface ChatMetricsDto
 */
export interface ChatMetricsDto {
    /**
     * 
     * @type {ContextBreakdown}
     * @memberof ChatMetricsDto
     */
    context: ContextBreakdown | null;
    /**
     * 
     * @type {string}
     * @memberof ChatMetricsDto
     */
    breakdownReason: string | null;
    /**
     * 
     * @type {PlanLimits}
     * @memberof ChatMetricsDto
     */
    plan: PlanLimits | null;
    /**
     * 
     * @type {string}
     * @memberof ChatMetricsDto
     */
    planReason: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatMetricsDto
     */
    takenAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatMetricsDto
     */
    planTakenAt: string | null;
    /**
     * 
     * @type {ChatTotals}
     * @memberof ChatMetricsDto
     */
    totals: ChatTotals;
}
/**
 * 
 * @export
 * @interface ChatSearchHit
 */
export interface ChatSearchHit {
    /**
     * Where in the run this is — the jump target
     * @type {number}
     * @memberof ChatSearchHit
     */
    seq: number;
    /**
     * 
     * @type {ItemKind}
     * @memberof ChatSearchHit
     */
    kind: ItemKind;
    /**
     * 
     * @type {string}
     * @memberof ChatSearchHit
     */
    role: string | null;
    /**
     * 
     * @type {string}
     * @memberof ChatSearchHit
     */
    snippet: string;
    /**
     * 
     * @type {string}
     * @memberof ChatSearchHit
     */
    createdAt: string;
}


/**
 * 
 * @export
 * @interface ChatSearchResultDto
 */
export interface ChatSearchResultDto {
    /**
     * 
     * @type {Array<ChatSearchHit>}
     * @memberof ChatSearchResultDto
     */
    hits: Array<ChatSearchHit>;
    /**
     * 
     * @type {string}
     * @memberof ChatSearchResultDto
     */
    partialReason: string | null;
}
/**
 * 
 * @export
 * @interface ChatTimelineDto
 */
export interface ChatTimelineDto {
    /**
     * 
     * @type {Array<ChatTimelineMarker>}
     * @memberof ChatTimelineDto
     */
    markers: Array<ChatTimelineMarker>;
    /**
     * 
     * @type {string}
     * @memberof ChatTimelineDto
     */
    partialReason: string | null;
}
/**
 * 
 * @export
 * @interface ChatTimelineMarker
 */
export interface ChatTimelineMarker {
    /**
     * Where in the run this is — the jump target
     * @type {number}
     * @memberof ChatTimelineMarker
     */
    seq: number;
    /**
     * 
     * @type {string}
     * @memberof ChatTimelineMarker
     */
    createdAt: string;
    /**
     * the message's own opening words, cut to a label's length
     * @type {string}
     * @memberof ChatTimelineMarker
     */
    preview: string;
    /**
     * 
     * @type {ChatTimelineSegment}
     * @memberof ChatTimelineMarker
     */
    segment: ChatTimelineSegment;
}
/**
 * 
 * @export
 * @interface ChatTimelineSegment
 */
export interface ChatTimelineSegment {
    /**
     * every non-user message row before the next user message — a delegate's output included, since it rides the same kind and role and only the payload tells them apart
     * @type {number}
     * @memberof ChatTimelineSegment
     */
    aiMessages: number;
    /**
     * 
     * @type {number}
     * @memberof ChatTimelineSegment
     */
    elapsedMs: number | null;
    /**
     * 
     * @type {ChatTotals}
     * @memberof ChatTimelineSegment
     */
    totals: ChatTotals;
}
/**
 * 
 * @export
 * @interface ChatTotals
 */
export interface ChatTotals {
    /**
     * turns that reported usage
     * @type {number}
     * @memberof ChatTotals
     */
    turns: number;
    /**
     * of those, how many reported a COST — the denominator for an average spend, since a turn on a CLI that reports no cost would otherwise dilute it
     * @type {number}
     * @memberof ChatTotals
     */
    costedTurns: number;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    costUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    estimatedCostUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    inputTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    outputTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    cacheReadTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    cacheCreationTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    thinkingTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ChatTotals
     */
    workedMs: number | null;
}
/**
 * 
 * @export
 * @interface ChatTotalsDto
 */
export interface ChatTotalsDto {
    /**
     * 
     * @type {ChatTotals}
     * @memberof ChatTotalsDto
     */
    totals: ChatTotals;
    /**
     * on a TEAM run, the merged wall-clock stretches in which some agent of it was working, with every `pausedSpans` stretch already cut out — a CLOCK reads their union, where `totals.workedMs` is a sum that runs N times faster while N agents work at once. Always empty for a chat, whose header draws its own clock
     * @type {Array<ActiveSpan>}
     * @memberof ChatTotalsDto
     */
    activeSpans: Array<ActiveSpan>;
    /**
     * on a TEAM run, where it waited on the user — an approval or question card open with no background shell or sub-agent running. The header clock stands still through them, the open one included. Always empty for a chat
     * @type {Array<PausedSpan>}
     * @memberof ChatTotalsDto
     */
    pausedSpans: Array<PausedSpan>;
}
/**
 * 
 * @export
 * @interface ChatUploadDto
 */
export interface ChatUploadDto {
    /**
     * absolute path of the stored copy
     * @type {string}
     * @memberof ChatUploadDto
     */
    path: string;
    /**
     * the file name it was stored under
     * @type {string}
     * @memberof ChatUploadDto
     */
    name: string;
    /**
     * decoded size in bytes
     * @type {number}
     * @memberof ChatUploadDto
     */
    bytes: number;
}
/**
 * 
 * @export
 * @interface CheckShareDestinationDto
 */
export interface CheckShareDestinationDto {
    /**
     * 
     * @type {CheckShareDestinationDtoShareDestination}
     * @memberof CheckShareDestinationDto
     */
    destination: CheckShareDestinationDtoShareDestination;
}
/**
 * @type CheckShareDestinationDtoShareDestination
 * 
 * @export
 */
export type CheckShareDestinationDtoShareDestination = ShareConfigDtoShareDestinationOneOf | ShareConfigDtoShareDestinationOneOf1 | ShareConfigDtoShareDestinationOneOf2;
/**
 * 
 * @export
 * @interface CloseRunGoalDto
 */
export interface CloseRunGoalDto {
    /**
     * 
     * @type {CloseRunGoalDtoGoalClosingStatus}
     * @memberof CloseRunGoalDto
     */
    status: CloseRunGoalDtoGoalClosingStatus;
    /**
     * 
     * @type {string}
     * @memberof CloseRunGoalDto
     */
    evidence: string;
}



/**
 * 
 * @export
 */
export const CloseRunGoalDtoGoalClosingStatus = {
    Achieved: 'achieved',
    NotAchieved: 'not_achieved',
    Dropped: 'dropped'
} as const;
export type CloseRunGoalDtoGoalClosingStatus = typeof CloseRunGoalDtoGoalClosingStatus[keyof typeof CloseRunGoalDtoGoalClosingStatus];

/**
 * 
 * @export
 * @interface ConfigDirPin
 */
export interface ConfigDirPin {
    /**
     * The config directory the CLI will actually use
     * @type {string}
     * @memberof ConfigDirPin
     */
    effective: string;
    /**
     * The settings file that pinned it — a path the user can open
     * @type {string}
     * @memberof ConfigDirPin
     */
    source: string;
}
/**
 * 
 * @export
 * @interface ContextBreakdown
 */
export interface ContextBreakdown {
    /**
     * 
     * @type {Array<ContextCategory>}
     * @memberof ContextBreakdown
     */
    categories: Array<ContextCategory>;
    /**
     * 
     * @type {number}
     * @memberof ContextBreakdown
     */
    totalTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ContextBreakdown
     */
    maxTokens: number | null;
    /**
     * 
     * @type {string}
     * @memberof ContextBreakdown
     */
    model: string | null;
    /**
     * 
     * @type {number}
     * @memberof ContextBreakdown
     */
    autoCompactAtTokens: number | null;
    /**
     * 
     * @type {boolean}
     * @memberof ContextBreakdown
     */
    autoCompactEnabled: boolean | null;
    /**
     * 
     * @type {Array<ContextMemoryFile>}
     * @memberof ContextBreakdown
     */
    memoryFiles: Array<ContextMemoryFile>;
    /**
     * 
     * @type {Array<ContextServer>}
     * @memberof ContextBreakdown
     */
    servers: Array<ContextServer>;
    /**
     * 
     * @type {ContextLastRequest}
     * @memberof ContextBreakdown
     */
    lastRequest?: ContextLastRequest | null;
}
/**
 * 
 * @export
 * @interface ContextCategory
 */
export interface ContextCategory {
    /**
     * the CLI's own name for this part of the window
     * @type {string}
     * @memberof ContextCategory
     */
    name: string;
    /**
     * 
     * @type {number}
     * @memberof ContextCategory
     */
    tokens: number;
    /**
     * available but not loaded, and so NOT counted in totalTokens — rendering it in the same bar reports a window several times fuller than it is
     * @type {boolean}
     * @memberof ContextCategory
     */
    deferred: boolean;
}
/**
 * 
 * @export
 * @interface ContextLastRequest
 */
export interface ContextLastRequest {
    /**
     * input sent fresh, cache excluded
     * @type {number}
     * @memberof ContextLastRequest
     */
    inputTokens: number;
    /**
     * input read from the prompt cache
     * @type {number}
     * @memberof ContextLastRequest
     */
    cachedInputTokens: number;
    /**
     * input newly written to the prompt cache
     * @type {number}
     * @memberof ContextLastRequest
     */
    cacheWriteInputTokens: number;
    /**
     * what the model produced, reasoning included
     * @type {number}
     * @memberof ContextLastRequest
     */
    outputTokens: number;
    /**
     * the share of outputTokens spent reasoning
     * @type {number}
     * @memberof ContextLastRequest
     */
    reasoningOutputTokens: number;
}
/**
 * 
 * @export
 * @interface ContextMemoryFile
 */
export interface ContextMemoryFile {
    /**
     * 
     * @type {string}
     * @memberof ContextMemoryFile
     */
    path: string;
    /**
     * 
     * @type {string}
     * @memberof ContextMemoryFile
     */
    kind: string | null;
    /**
     * 
     * @type {number}
     * @memberof ContextMemoryFile
     */
    tokens: number | null;
}
/**
 * 
 * @export
 * @interface ContextServer
 */
export interface ContextServer {
    /**
     * 
     * @type {string}
     * @memberof ContextServer
     */
    name: string;
    /**
     * 
     * @type {number}
     * @memberof ContextServer
     */
    tokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof ContextServer
     */
    toolCount: number;
    /**
     * how many of them are actually in the window right now
     * @type {number}
     * @memberof ContextServer
     */
    loadedToolCount: number;
}
/**
 * 
 * @export
 * @interface CopyPluginMcpServerDto
 */
export interface CopyPluginMcpServerDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof CopyPluginMcpServerDto
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof CopyPluginMcpServerDto
     */
    cwd: string;
    /**
     * 
     * @type {string}
     * @memberof CopyPluginMcpServerDto
     */
    configDir?: string;
    /**
     * 
     * @type {string}
     * @memberof CopyPluginMcpServerDto
     */
    plugin: string;
    /**
     * 
     * @type {string}
     * @memberof CopyPluginMcpServerDto
     */
    server: string;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof CopyPluginMcpServerDto
     */
    variables: { [key: string]: string; };
}


/**
 * 
 * @export
 * @interface CreateChatDto
 */
export interface CreateChatDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof CreateChatDto
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    cwd: string;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    startSha?: string;
    /**
     * 
     * @type {boolean}
     * @memberof CreateChatDto
     */
    startDirty?: boolean;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    model?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    title?: string;
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof CreateChatDto
     */
    approval?: ChatApprovalMode;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    effort?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    contextWindow?: string;
    /**
     * 
     * @type {number}
     * @memberof CreateChatDto
     */
    autoCompactPercent?: number;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof CreateChatDto
     */
    modelParameters?: { [key: string]: string; };
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    configDir?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    customInstructions?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    replyLanguage?: string;
    /**
     * 
     * @type {{ [key: string]: { [key: string]: boolean; }; }}
     * @memberof CreateChatDto
     */
    agentOptions?: { [key: string]: { [key: string]: boolean; }; };
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    resumeSessionId?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateChatDto
     */
    projectId?: string | null;
}


/**
 * 
 * @export
 * @interface CreateKnowledgeDto
 */
export interface CreateKnowledgeDto {
    /**
     * 
     * @type {string}
     * @memberof CreateKnowledgeDto
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof CreateKnowledgeDto
     */
    whenToRead: string;
    /**
     * 
     * @type {string}
     * @memberof CreateKnowledgeDto
     */
    body: string;
    /**
     * 
     * @type {string}
     * @memberof CreateKnowledgeDto
     */
    handle?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateKnowledgeDto
     */
    place: string;
}
/**
 * 
 * @export
 * @interface CreateLabelInstructionDto
 */
export interface CreateLabelInstructionDto {
    /**
     * 
     * @type {string}
     * @memberof CreateLabelInstructionDto
     */
    label: string;
    /**
     * 
     * @type {string}
     * @memberof CreateLabelInstructionDto
     */
    projectId?: string | null;
    /**
     * 
     * @type {string}
     * @memberof CreateLabelInstructionDto
     */
    instructions: string;
}
/**
 * 
 * @export
 * @interface CreateMemoryDto
 */
export interface CreateMemoryDto {
    /**
     * 
     * @type {string}
     * @memberof CreateMemoryDto
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof CreateMemoryDto
     */
    body: string;
    /**
     * 
     * @type {string}
     * @memberof CreateMemoryDto
     */
    type: CreateMemoryDtoTypeEnum;
    /**
     * 
     * @type {string}
     * @memberof CreateMemoryDto
     */
    projectId: string | null;
    /**
     * 
     * @type {string}
     * @memberof CreateMemoryDto
     */
    teamSlug?: string | null;
    /**
     * 
     * @type {Array<string>}
     * @memberof CreateMemoryDto
     */
    notDuplicateOf?: Array<string>;
}


/**
 * @export
 */
export const CreateMemoryDtoTypeEnum = {
    User: 'user',
    Feedback: 'feedback',
    Project: 'project',
    Reference: 'reference'
} as const;
export type CreateMemoryDtoTypeEnum = typeof CreateMemoryDtoTypeEnum[keyof typeof CreateMemoryDtoTypeEnum];

/**
 * 
 * @export
 * @interface CreateProjectDto
 */
export interface CreateProjectDto {
    /**
     * 
     * @type {string}
     * @memberof CreateProjectDto
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof CreateProjectDto
     */
    folder: string;
    /**
     * 
     * @type {string}
     * @memberof CreateProjectDto
     */
    groupId?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateProjectDto
     */
    description?: string;
    /**
     * 
     * @type {Array<ProjectInstructionBlock>}
     * @memberof CreateProjectDto
     */
    instructionBlocks?: Array<ProjectInstructionBlock>;
    /**
     * 
     * @type {AgentKind}
     * @memberof CreateProjectDto
     */
    agentKind?: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof CreateProjectDto
     */
    model?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateProjectDto
     */
    effort?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateProjectDto
     */
    contextWindow?: string;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof CreateProjectDto
     */
    modelParameters?: { [key: string]: string; };
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof CreateProjectDto
     */
    approval?: ChatApprovalMode;
    /**
     * 
     * @type {string}
     * @memberof CreateProjectDto
     */
    configDir?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateProjectDto
     */
    teamSlug?: string;
    /**
     * 
     * @type {TaskSource}
     * @memberof CreateProjectDto
     */
    provider?: TaskSource;
    /**
     * 
     * @type {boolean}
     * @memberof CreateProjectDto
     */
    autopilotEnabled?: boolean;
    /**
     * 
     * @type {TaskStatus}
     * @memberof CreateProjectDto
     */
    autopilotIntakeStatus?: TaskStatus;
    /**
     * 
     * @type {number}
     * @memberof CreateProjectDto
     */
    autopilotMaxConcurrent?: number;
}


/**
 * 
 * @export
 * @interface CreateRunGoalDto
 */
export interface CreateRunGoalDto {
    /**
     * 
     * @type {string}
     * @memberof CreateRunGoalDto
     */
    text: string;
}
/**
 * 
 * @export
 * @interface CreateRunGroupDto
 */
export interface CreateRunGroupDto {
    /**
     * 
     * @type {string}
     * @memberof CreateRunGroupDto
     */
    name: string;
    /**
     * 
     * @type {RunGroupColor}
     * @memberof CreateRunGroupDto
     */
    color?: RunGroupColor;
    /**
     * 
     * @type {string}
     * @memberof CreateRunGroupDto
     */
    autoCwd?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateRunGroupDto
     */
    autoTeamId?: string;
}


/**
 * 
 * @export
 * @interface CreateShareDto
 */
export interface CreateShareDto {
    /**
     * 
     * @type {string}
     * @memberof CreateShareDto
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof CreateShareDto
     */
    artifactId: string;
    /**
     * 
     * @type {string}
     * @memberof CreateShareDto
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof CreateShareDto
     */
    destinationId?: string;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof CreateShareDto
     */
    themeVars?: { [key: string]: string; };
}
/**
 * 
 * @export
 * @interface CreateTaskDto
 */
export interface CreateTaskDto {
    /**
     * 
     * @type {string}
     * @memberof CreateTaskDto
     */
    projectId: string;
    /**
     * 
     * @type {string}
     * @memberof CreateTaskDto
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof CreateTaskDto
     */
    description?: string;
    /**
     * 
     * @type {TaskStatus}
     * @memberof CreateTaskDto
     */
    status?: TaskStatus;
    /**
     * 
     * @type {Array<string>}
     * @memberof CreateTaskDto
     */
    labels?: Array<string>;
    /**
     * 
     * @type {TaskPriority}
     * @memberof CreateTaskDto
     */
    priority?: TaskPriority;
    /**
     * 
     * @type {string}
     * @memberof CreateTaskDto
     */
    dueDate?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateTaskDto
     */
    folder?: string;
    /**
     * 
     * @type {AgentKind}
     * @memberof CreateTaskDto
     */
    agentKind?: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof CreateTaskDto
     */
    model?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateTaskDto
     */
    effort?: string;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof CreateTaskDto
     */
    modelParameters?: { [key: string]: string; };
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof CreateTaskDto
     */
    approval?: ChatApprovalMode;
    /**
     * 
     * @type {string}
     * @memberof CreateTaskDto
     */
    configDir?: string;
    /**
     * 
     * @type {string}
     * @memberof CreateTaskDto
     */
    teamSlug?: string;
    /**
     * 
     * @type {TaskSource}
     * @memberof CreateTaskDto
     */
    source?: TaskSource;
    /**
     * 
     * @type {string}
     * @memberof CreateTaskDto
     */
    sourceRef?: string;
}


/**
 * 
 * @export
 * @interface CreateTeamDto
 */
export interface CreateTeamDto {
    /**
     * 
     * @type {string}
     * @memberof CreateTeamDto
     */
    slug?: string;
    /**
     * 
     * @type {Team}
     * @memberof CreateTeamDto
     */
    team: Team;
}

/**
 * 
 * @export
 */
export const DebugChannel = {
    Daemon: 'daemon',
    Transcript: 'transcript',
    AgentStdio: 'agent-stdio',
    Ui: 'ui'
} as const;
export type DebugChannel = typeof DebugChannel[keyof typeof DebugChannel];

/**
 * 
 * @export
 * @interface DebugChannelsDto
 */
export interface DebugChannelsDto {
    /**
     * 
     * @type {Array<DebugChannel>}
     * @memberof DebugChannelsDto
     */
    channels: Array<DebugChannel>;
}

/**
 * 
 * @export
 */
export const DebugLevel = {
    Trace: 'trace',
    Debug: 'debug',
    Info: 'info',
    Warn: 'warn',
    Error: 'error'
} as const;
export type DebugLevel = typeof DebugLevel[keyof typeof DebugLevel];

/**
 * 
 * @export
 * @interface DebugLogPageDto
 */
export interface DebugLogPageDto {
    /**
     * 
     * @type {Array<DebugLogPageDtoEntriesInner>}
     * @memberof DebugLogPageDto
     */
    entries: Array<DebugLogPageDtoEntriesInner>;
    /**
     * 
     * @type {number}
     * @memberof DebugLogPageDto
     */
    lastSeq: number;
    /**
     * 
     * @type {number}
     * @memberof DebugLogPageDto
     */
    dropped: number;
    /**
     * 
     * @type {Array<DebugChannel>}
     * @memberof DebugLogPageDto
     */
    channels: Array<DebugChannel>;
    /**
     * 
     * @type {string}
     * @memberof DebugLogPageDto
     */
    filePath: string | null;
}
/**
 * 
 * @export
 * @interface DebugLogPageDtoEntriesInner
 */
export interface DebugLogPageDtoEntriesInner {
    /**
     * Monotonic within one daemon launch
     * @type {number}
     * @memberof DebugLogPageDtoEntriesInner
     */
    seq: number;
    /**
     * ISO timestamp
     * @type {string}
     * @memberof DebugLogPageDtoEntriesInner
     */
    at: string;
    /**
     * 
     * @type {DebugChannel}
     * @memberof DebugLogPageDtoEntriesInner
     */
    channel: DebugChannel;
    /**
     * 
     * @type {DebugLevel}
     * @memberof DebugLogPageDtoEntriesInner
     */
    level: DebugLevel;
    /**
     * 
     * @type {string}
     * @memberof DebugLogPageDtoEntriesInner
     */
    message: string;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof DebugLogPageDtoEntriesInner
     */
    context: { [key: string]: string; } | null;
}


/**
 * 
 * @export
 * @interface DebugSettingsDto
 */
export interface DebugSettingsDto {
    /**
     * 
     * @type {Array<DebugChannel>}
     * @memberof DebugSettingsDto
     */
    channels: Array<DebugChannel>;
}
/**
 * 
 * @export
 * @interface DeliveredWaitingMessageDto
 */
export interface DeliveredWaitingMessageDto {
    /**
     * 
     * @type {string}
     * @memberof DeliveredWaitingMessageDto
     */
    outcome: DeliveredWaitingMessageDtoOutcomeEnum;
    /**
     * 
     * @type {string}
     * @memberof DeliveredWaitingMessageDto
     */
    reason: DeliveredWaitingMessageDtoReasonEnum | null;
}


/**
 * @export
 */
export const DeliveredWaitingMessageDtoOutcomeEnum = {
    Joined: 'joined',
    Woken: 'woken',
    Waiting: 'waiting'
} as const;
export type DeliveredWaitingMessageDtoOutcomeEnum = typeof DeliveredWaitingMessageDtoOutcomeEnum[keyof typeof DeliveredWaitingMessageDtoOutcomeEnum];

/**
 * @export
 */
export const DeliveredWaitingMessageDtoReasonEnum = {
    RunningTurn: 'running_turn',
    Stopped: 'stopped',
    Failed: 'failed',
    NotStarted: 'not_started',
    Question: 'question',
    SenderOptedOut: 'sender_opted_out',
    ColdAndLarge: 'cold_and_large',
    WakeLimit: 'wake_limit'
} as const;
export type DeliveredWaitingMessageDtoReasonEnum = typeof DeliveredWaitingMessageDtoReasonEnum[keyof typeof DeliveredWaitingMessageDtoReasonEnum];

/**
 * 
 * @export
 * @interface DiagnosticsReportDto
 */
export interface DiagnosticsReportDto {
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDto
     */
    generatedAt: string;
    /**
     * 
     * @type {DiagnosticsReportDtoDaemon}
     * @memberof DiagnosticsReportDto
     */
    daemon: DiagnosticsReportDtoDaemon;
    /**
     * 
     * @type {Array<DiagnosticsReportDtoAgentsInner>}
     * @memberof DiagnosticsReportDto
     */
    agents: Array<DiagnosticsReportDtoAgentsInner>;
    /**
     * 
     * @type {DiagnosticsReportDtoRuns}
     * @memberof DiagnosticsReportDto
     */
    runs: DiagnosticsReportDtoRuns;
    /**
     * 
     * @type {Array<DebugLogPageDtoEntriesInner>}
     * @memberof DiagnosticsReportDto
     */
    recentEntries: Array<DebugLogPageDtoEntriesInner>;
}
/**
 * 
 * @export
 * @interface DiagnosticsReportDtoAgentsInner
 */
export interface DiagnosticsReportDtoAgentsInner {
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoAgentsInner
     */
    kind: string;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoAgentsInner
     */
    binary: string;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoAgentsInner
     */
    version: string | null;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoAgentsInner
     */
    unavailableReason: string | null;
}
/**
 * 
 * @export
 * @interface DiagnosticsReportDtoDaemon
 */
export interface DiagnosticsReportDtoDaemon {
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    version: string;
    /**
     * 
     * @type {number}
     * @memberof DiagnosticsReportDtoDaemon
     */
    pid: number;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    host: string;
    /**
     * 
     * @type {number}
     * @memberof DiagnosticsReportDtoDaemon
     */
    port: number | null;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    startedAt: string;
    /**
     * 
     * @type {number}
     * @memberof DiagnosticsReportDtoDaemon
     */
    uptimeSeconds: number;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    nodeVersion: string;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    platform: string;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    arch: string;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    userDataDir: string;
    /**
     * 
     * @type {string}
     * @memberof DiagnosticsReportDtoDaemon
     */
    logFilePath: string | null;
}
/**
 * 
 * @export
 * @interface DiagnosticsReportDtoRuns
 */
export interface DiagnosticsReportDtoRuns {
    /**
     * 
     * @type {number}
     * @memberof DiagnosticsReportDtoRuns
     */
    total: number;
    /**
     * 
     * @type {number}
     * @memberof DiagnosticsReportDtoRuns
     */
    running: number;
    /**
     * 
     * @type {number}
     * @memberof DiagnosticsReportDtoRuns
     */
    liveTurns: number;
    /**
     * 
     * @type {number}
     * @memberof DiagnosticsReportDtoRuns
     */
    liveSessions: number;
}
/**
 * 
 * @export
 * @interface DisplayedPullRequest
 */
export interface DisplayedPullRequest {
    /**
     * 
     * @type {string}
     * @memberof DisplayedPullRequest
     */
    owner: string;
    /**
     * 
     * @type {string}
     * @memberof DisplayedPullRequest
     */
    repo: string;
    /**
     * 
     * @type {number}
     * @memberof DisplayedPullRequest
     */
    number: number;
    /**
     * 
     * @type {string}
     * @memberof DisplayedPullRequest
     */
    url: string;
    /**
     * 
     * @type {number}
     * @memberof DisplayedPullRequest
     */
    seq: number;
    /**
     * The run opened it, rather than only touching it
     * @type {boolean}
     * @memberof DisplayedPullRequest
     */
    opened: boolean;
    /**
     * 
     * @type {PullRequestOutcome}
     * @memberof DisplayedPullRequest
     */
    outcome?: PullRequestOutcome | null;
}
/**
 * 
 * @export
 * @interface EditLessonDto
 */
export interface EditLessonDto {
    /**
     * 
     * @type {string}
     * @memberof EditLessonDto
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof EditLessonDto
     */
    rule: string;
}
/**
 * 
 * @export
 * @interface EditRunGoalDto
 */
export interface EditRunGoalDto {
    /**
     * 
     * @type {string}
     * @memberof EditRunGoalDto
     */
    text: string;
}
/**
 * 
 * @export
 * @interface ExportTeamDto
 */
export interface ExportTeamDto {
    /**
     * 
     * @type {string}
     * @memberof ExportTeamDto
     */
    path: string;
}
/**
 * 
 * @export
 * @interface ExportedDto
 */
export interface ExportedDto {
    /**
     * 
     * @type {boolean}
     * @memberof ExportedDto
     */
    exported: boolean;
}
/**
 * 
 * @export
 * @interface FigureSpread
 */
export interface FigureSpread {
    /**
     * 
     * @type {number}
     * @memberof FigureSpread
     */
    min: number;
    /**
     * 
     * @type {number}
     * @memberof FigureSpread
     */
    median: number;
    /**
     * 
     * @type {number}
     * @memberof FigureSpread
     */
    max: number;
}
/**
 * 
 * @export
 * @interface FindFinishedTasksDto
 */
export interface FindFinishedTasksDto {
    /**
     * 
     * @type {Array<string>}
     * @memberof FindFinishedTasksDto
     */
    taskIds: Array<string>;
}
/**
 * 
 * @export
 * @interface FinishedTasksDto
 */
export interface FinishedTasksDto {
    /**
     * The subset whose work is finished — Done with no run working in it, or no longer a card at all
     * @type {Array<string>}
     * @memberof FinishedTasksDto
     */
    taskIds: Array<string>;
}
/**
 * 
 * @export
 * @interface ForgetAllMemoriesDto
 */
export interface ForgetAllMemoriesDto {
    /**
     * 
     * @type {number}
     * @memberof ForgetAllMemoriesDto
     */
    forgotten: number;
}
/**
 * 
 * @export
 * @interface ForgetMemoryBatchDto
 */
export interface ForgetMemoryBatchDto {
    /**
     * 
     * @type {Array<string>}
     * @memberof ForgetMemoryBatchDto
     */
    ids: Array<string>;
}
/**
 * 
 * @export
 * @interface ForgottenInstructionsDto
 */
export interface ForgottenInstructionsDto {
    /**
     * Runs whose snapshotted custom instructions were cleared
     * @type {number}
     * @memberof ForgottenInstructionsDto
     */
    cleared: number;
}
/**
 * 
 * @export
 * @interface GlobalChatSearchHit
 */
export interface GlobalChatSearchHit {
    /**
     * Where in the run this is — the jump target
     * @type {number}
     * @memberof GlobalChatSearchHit
     */
    seq: number;
    /**
     * 
     * @type {ItemKind}
     * @memberof GlobalChatSearchHit
     */
    kind: ItemKind;
    /**
     * 
     * @type {string}
     * @memberof GlobalChatSearchHit
     */
    role: string | null;
    /**
     * 
     * @type {string}
     * @memberof GlobalChatSearchHit
     */
    snippet: string;
    /**
     * 
     * @type {string}
     * @memberof GlobalChatSearchHit
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof GlobalChatSearchHit
     */
    runId: string;
    /**
     * The matched row — what `read_chat_context` reads around
     * @type {string}
     * @memberof GlobalChatSearchHit
     */
    itemId: string;
    /**
     * 
     * @type {string}
     * @memberof GlobalChatSearchHit
     */
    memberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof GlobalChatSearchHit
     */
    title: string | null;
    /**
     * 
     * @type {string}
     * @memberof GlobalChatSearchHit
     */
    cwd: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof GlobalChatSearchHit
     */
    archived: boolean;
    /**
     * Relevance — higher is a better match
     * @type {number}
     * @memberof GlobalChatSearchHit
     */
    score: number;
}


/**
 * 
 * @export
 * @interface GlobalChatSearchResultDto
 */
export interface GlobalChatSearchResultDto {
    /**
     * 
     * @type {Array<GlobalChatSearchHit>}
     * @memberof GlobalChatSearchResultDto
     */
    hits: Array<GlobalChatSearchHit>;
    /**
     * 
     * @type {string}
     * @memberof GlobalChatSearchResultDto
     */
    partialReason: string | null;
}
/**
 * 
 * @export
 * @interface GoalFigures
 */
export interface GoalFigures {
    /**
     * every goal recorded, dropped ones included
     * @type {number}
     * @memberof GoalFigures
     */
    recorded: number;
    /**
     * 
     * @type {number}
     * @memberof GoalFigures
     */
    achieved: number;
    /**
     * 
     * @type {number}
     * @memberof GoalFigures
     */
    notAchieved: number;
    /**
     * 
     * @type {number}
     * @memberof GoalFigures
     */
    dropped: number;
    /**
     * 
     * @type {number}
     * @memberof GoalFigures
     */
    open: number;
    /**
     * 
     * @type {number}
     * @memberof GoalFigures
     */
    achievedShare: number | null;
    /**
     * 
     * @type {number}
     * @memberof GoalFigures
     */
    runsWithGoals: number;
    /**
     * runs the ledgers watched from their start — what coverage is out of
     * @type {number}
     * @memberof GoalFigures
     */
    measuredRuns: number;
    /**
     * 
     * @type {number}
     * @memberof GoalFigures
     */
    coverage: number | null;
}

/**
 * 
 * @export
 */
export const GoalSource = {
    User: 'user',
    Agent: 'agent'
} as const;
export type GoalSource = typeof GoalSource[keyof typeof GoalSource];


/**
 * 
 * @export
 */
export const GoalStatus = {
    Open: 'open',
    Achieved: 'achieved',
    NotAchieved: 'not_achieved',
    Dropped: 'dropped'
} as const;
export type GoalStatus = typeof GoalStatus[keyof typeof GoalStatus];

/**
 * 
 * @export
 * @interface HandoffTargetDto
 */
export interface HandoffTargetDto {
    /**
     * Which delivery applies; anything else is unavailable
     * @type {string}
     * @memberof HandoffTargetDto
     */
    kind: HandoffTargetDtoKindEnum;
    /**
     * 
     * @type {string}
     * @memberof HandoffTargetDto
     */
    command: string | null;
    /**
     * Arguments; empty unless kind=command
     * @type {Array<string>}
     * @memberof HandoffTargetDto
     */
    args: Array<string>;
    /**
     * 
     * @type {string}
     * @memberof HandoffTargetDto
     */
    cwd: string | null;
    /**
     * Environment the invocation needs; empty unless kind=command. Carries the run’s config directory, which has no argv form
     * @type {{ [key: string]: string; }}
     * @memberof HandoffTargetDto
     */
    env: { [key: string]: string; };
    /**
     * 
     * @type {string}
     * @memberof HandoffTargetDto
     */
    display: string | null;
    /**
     * 
     * @type {string}
     * @memberof HandoffTargetDto
     */
    unavailableReason: string | null;
}


/**
 * @export
 */
export const HandoffTargetDtoKindEnum = {
    Command: 'command',
    Unavailable: 'unavailable'
} as const;
export type HandoffTargetDtoKindEnum = typeof HandoffTargetDtoKindEnum[keyof typeof HandoffTargetDtoKindEnum];

/**
 * 
 * @export
 * @interface HealthProblem
 */
export interface HealthProblem {
    /**
     * 
     * @type {string}
     * @memberof HealthProblem
     */
    kind: HealthProblemKindEnum;
    /**
     * 
     * @type {string}
     * @memberof HealthProblem
     */
    level: HealthProblemLevelEnum;
    /**
     * One plain sentence naming the setting
     * @type {string}
     * @memberof HealthProblem
     */
    message: string;
    /**
     * 
     * @type {AgentKind}
     * @memberof HealthProblem
     */
    agent: AgentKind | null;
    /**
     * 
     * @type {number}
     * @memberof HealthProblem
     */
    poolMember: number | null;
    /**
     * 
     * @type {string}
     * @memberof HealthProblem
     */
    configDir: string | null;
    /**
     * 
     * @type {string}
     * @memberof HealthProblem
     */
    server: string | null;
    /**
     * 
     * @type {string}
     * @memberof HealthProblem
     */
    model: string | null;
}


/**
 * @export
 */
export const HealthProblemKindEnum = {
    CliMissing: 'cli_missing',
    CliUnknown: 'cli_unknown',
    ProfileMissing: 'profile_missing',
    NoTrigger: 'no_trigger',
    McpFailed: 'mcp_failed',
    McpNeedsAuth: 'mcp_needs_auth',
    McpDisconnected: 'mcp_disconnected',
    ModelNotOffered: 'model_not_offered',
    EffortNotOffered: 'effort_not_offered',
    StageMemberMissing: 'stage_member_missing'
} as const;
export type HealthProblemKindEnum = typeof HealthProblemKindEnum[keyof typeof HealthProblemKindEnum];

/**
 * @export
 */
export const HealthProblemLevelEnum = {
    Error: 'error',
    Warning: 'warning'
} as const;
export type HealthProblemLevelEnum = typeof HealthProblemLevelEnum[keyof typeof HealthProblemLevelEnum];

/**
 * 
 * @export
 * @interface ImportMemoriesDto
 */
export interface ImportMemoriesDto {
    /**
     * 
     * @type {Array<MemoryImportPreviewRequestDtoProfilesInner>}
     * @memberof ImportMemoriesDto
     */
    profiles: Array<MemoryImportPreviewRequestDtoProfilesInner>;
    /**
     * 
     * @type {Array<ImportMemoriesDtoRowsInner>}
     * @memberof ImportMemoriesDto
     */
    rows: Array<ImportMemoriesDtoRowsInner>;
}
/**
 * 
 * @export
 * @interface ImportMemoriesDtoRowsInner
 */
export interface ImportMemoriesDtoRowsInner {
    /**
     * 
     * @type {string}
     * @memberof ImportMemoriesDtoRowsInner
     */
    key: string;
    /**
     * 
     * @type {string}
     * @memberof ImportMemoriesDtoRowsInner
     */
    type: ImportMemoriesDtoRowsInnerTypeEnum;
    /**
     * 
     * @type {string}
     * @memberof ImportMemoriesDtoRowsInner
     */
    projectId: string | null;
}


/**
 * @export
 */
export const ImportMemoriesDtoRowsInnerTypeEnum = {
    User: 'user',
    Feedback: 'feedback',
    Project: 'project',
    Reference: 'reference'
} as const;
export type ImportMemoriesDtoRowsInnerTypeEnum = typeof ImportMemoriesDtoRowsInnerTypeEnum[keyof typeof ImportMemoriesDtoRowsInnerTypeEnum];

/**
 * 
 * @export
 * @interface ImportTeamDto
 */
export interface ImportTeamDto {
    /**
     * 
     * @type {string}
     * @memberof ImportTeamDto
     */
    path: string;
}
/**
 * 
 * @export
 * @interface InstructionBlock
 */
export interface InstructionBlock {
    /**
     * Unique block id within the team
     * @type {string}
     * @memberof InstructionBlock
     */
    id: string;
    /**
     * Short name shown in the editor
     * @type {string}
     * @memberof InstructionBlock
     */
    title: string;
    /**
     * Instruction text composed into every audience member’s turns
     * @type {string}
     * @memberof InstructionBlock
     */
    text: string;
    /**
     * 
     * @type {InstructionBlockAudience}
     * @memberof InstructionBlock
     */
    audience: InstructionBlockAudience;
}
/**
 * 'everyone', or the ids of the members it applies to
 * @export
 * @interface InstructionBlockAudience
 */
export interface InstructionBlockAudience {
}
/**
 * 
 * @export
 * @interface InstructionBlockSize
 */
export interface InstructionBlockSize {
    /**
     * 
     * @type {string}
     * @memberof InstructionBlockSize
     */
    blockId: string;
    /**
     * Length of the text composed into a turn — 0 for a blank block
     * @type {number}
     * @memberof InstructionBlockSize
     */
    chars: number;
    /**
     * 
     * @type {number}
     * @memberof InstructionBlockSize
     */
    approxTokens: number;
    /**
     * How many members’ turns carry it
     * @type {number}
     * @memberof InstructionBlockSize
     */
    reaches: number;
}
/**
 * 
 * @export
 * @interface InstructionSizePart
 */
export interface InstructionSizePart {
    /**
     * 
     * @type {InstructionSizeSource}
     * @memberof InstructionSizePart
     */
    source: InstructionSizeSource;
    /**
     * For an instructionBlocks part: the block whose text it is (one part per block addressed to the member)
     * @type {string}
     * @memberof InstructionSizePart
     */
    blockId?: string;
    /**
     * 
     * @type {number}
     * @memberof InstructionSizePart
     */
    chars: number;
    /**
     * 
     * @type {number}
     * @memberof InstructionSizePart
     */
    approxTokens: number;
}



/**
 * 
 * @export
 */
export const InstructionSizeSource = {
    Preamble: 'preamble',
    BackgroundWorkNote: 'backgroundWorkNote',
    ReplyLanguage: 'replyLanguage',
    CustomInstructions: 'customInstructions',
    ProjectInstructions: 'projectInstructions',
    MemoryIndex: 'memoryIndex',
    KnowledgeIndex: 'knowledgeIndex',
    TaskInstructions: 'taskInstructions',
    TeamInstructions: 'teamInstructions',
    InstructionBlocks: 'instructionBlocks',
    StageMap: 'stageMap',
    Instructions: 'instructions',
    Character: 'character',
    AnsweringACall: 'answeringACall',
    CallSurface: 'callSurface'
} as const;
export type InstructionSizeSource = typeof InstructionSizeSource[keyof typeof InstructionSizeSource];

/**
 * 
 * @export
 * @interface InstructionSizesDto
 */
export interface InstructionSizesDto {
    /**
     * 
     * @type {Array<MemberInstructionSize>}
     * @memberof InstructionSizesDto
     */
    members: Array<MemberInstructionSize>;
    /**
     * 
     * @type {Array<InstructionBlockSize>}
     * @memberof InstructionSizesDto
     */
    blocks: Array<InstructionBlockSize>;
}
/**
 * 
 * @export
 * @interface ItemDto
 */
export interface ItemDto {
    /**
     * 
     * @type {string}
     * @memberof ItemDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof ItemDto
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof ItemDto
     */
    memberId: string | null;
    /**
     * Monotonic per-run sequence — the replay cursor
     * @type {number}
     * @memberof ItemDto
     */
    seq: number;
    /**
     * 
     * @type {ItemKind}
     * @memberof ItemDto
     */
    kind: ItemKind;
    /**
     * 
     * @type {string}
     * @memberof ItemDto
     */
    role: string | null;
    /**
     * 
     * @type {any}
     * @memberof ItemDto
     */
    payload: any | null;
    /**
     * 
     * @type {string}
     * @memberof ItemDto
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof ItemDto
     */
    inCall?: string | null;
}



/**
 * 
 * @export
 */
export const ItemKind = {
    Message: 'message',
    Reasoning: 'reasoning',
    ToolCall: 'tool_call',
    ToolResult: 'tool_result',
    TurnComplete: 'turn_complete',
    TurnCancelled: 'turn_cancelled',
    System: 'system',
    Error: 'error',
    Status: 'status',
    ApprovalRequest: 'approval_request',
    ApprovalVerdict: 'approval_verdict',
    Unanswerable: 'unanswerable',
    CallStarted: 'call_started',
    CallResult: 'call_result',
    AwaitCollected: 'await_collected',
    CallQuestion: 'call_question',
    CallAnswer: 'call_answer',
    SubagentInfo: 'subagent_info',
    WorkflowInfo: 'workflow_info',
    TaskList: 'task_list',
    ShellOpen: 'shell_open',
    ShellInfo: 'shell_info',
    ReportFindings: 'report_findings',
    ShowChart: 'show_chart',
    ShowMetrics: 'show_metrics',
    ShowComparison: 'show_comparison',
    ShowGallery: 'show_gallery',
    ShowArtifact: 'show_artifact',
    Recommendations: 'recommendations',
    RecommendationOutcome: 'recommendation_outcome',
    Action: 'action',
    ActionOutcome: 'action_outcome',
    TeamNote: 'team_note',
    RunOutcome: 'run_outcome',
    StageChange: 'stage_change',
    ThreadOutcome: 'thread_outcome',
    Lessons: 'lessons',
    LessonOutcome: 'lesson_outcome'
} as const;
export type ItemKind = typeof ItemKind[keyof typeof ItemKind];

/**
 * 
 * @export
 * @interface KeptSessionConfigDto
 */
export interface KeptSessionConfigDto {
    /**
     * 
     * @type {number}
     * @memberof KeptSessionConfigDto
     */
    idleMinutes: number;
    /**
     * 
     * @type {number}
     * @memberof KeptSessionConfigDto
     */
    limit: number | null;
}
/**
 * 
 * @export
 * @interface KeptSessionConfigStateDto
 */
export interface KeptSessionConfigStateDto {
    /**
     * 
     * @type {number}
     * @memberof KeptSessionConfigStateDto
     */
    idleMinutes: number;
    /**
     * 
     * @type {number}
     * @memberof KeptSessionConfigStateDto
     */
    limit: number | null;
    /**
     * The limit picked from this Mac's memory
     * @type {number}
     * @memberof KeptSessionConfigStateDto
     */
    automaticLimit: number;
    /**
     * What one kept process is estimated to take
     * @type {number}
     * @memberof KeptSessionConfigStateDto
     */
    sessionMemoryBytes: number;
    /**
     * This Mac's memory
     * @type {number}
     * @memberof KeptSessionConfigStateDto
     */
    totalMemoryBytes: number;
    /**
     * How long after its last use a chat's own process is never closed for room
     * @type {number}
     * @memberof KeptSessionConfigStateDto
     */
    recentlyUsedMinutes: number;
}
/**
 * 
 * @export
 * @interface KnowledgeConfigAckDto
 */
export interface KnowledgeConfigAckDto {
    /**
     * 
     * @type {boolean}
     * @memberof KnowledgeConfigAckDto
     */
    enabled: boolean;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeConfigAckDto
     */
    agentWrites: KnowledgeConfigAckDtoAgentWritesEnum;
}


/**
 * @export
 */
export const KnowledgeConfigAckDtoAgentWritesEnum = {
    Review: 'review',
    Direct: 'direct',
    Off: 'off'
} as const;
export type KnowledgeConfigAckDtoAgentWritesEnum = typeof KnowledgeConfigAckDtoAgentWritesEnum[keyof typeof KnowledgeConfigAckDtoAgentWritesEnum];

/**
 * 
 * @export
 * @interface KnowledgeConfigDto
 */
export interface KnowledgeConfigDto {
    /**
     * 
     * @type {boolean}
     * @memberof KnowledgeConfigDto
     */
    enabled: boolean;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeConfigDto
     */
    agentWrites: KnowledgeConfigDtoAgentWritesEnum;
}


/**
 * @export
 */
export const KnowledgeConfigDtoAgentWritesEnum = {
    Review: 'review',
    Direct: 'direct',
    Off: 'off'
} as const;
export type KnowledgeConfigDtoAgentWritesEnum = typeof KnowledgeConfigDtoAgentWritesEnum[keyof typeof KnowledgeConfigDtoAgentWritesEnum];

/**
 * 
 * @export
 * @interface KnowledgeCountsDto
 */
export interface KnowledgeCountsDto {
    /**
     * 
     * @type {Array<KnowledgeCountsDtoPlacesInner>}
     * @memberof KnowledgeCountsDto
     */
    places: Array<KnowledgeCountsDtoPlacesInner>;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeCountsDto
     */
    active: number;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeCountsDto
     */
    waiting: number;
}
/**
 * 
 * @export
 * @interface KnowledgeCountsDtoPlacesInner
 */
export interface KnowledgeCountsDtoPlacesInner {
    /**
     * 
     * @type {string}
     * @memberof KnowledgeCountsDtoPlacesInner
     */
    place: string;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeCountsDtoPlacesInner
     */
    active: number;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeCountsDtoPlacesInner
     */
    waiting: number;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeCountsDtoPlacesInner
     */
    documents: number;
}
/**
 * 
 * @export
 * @interface KnowledgeDocumentDetailDto
 */
export interface KnowledgeDocumentDetailDto {
    /**
     * 
     * @type {string}
     * @memberof KnowledgeDocumentDetailDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeDocumentDetailDto
     */
    handle: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeDocumentDetailDto
     */
    place: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeDocumentDetailDto
     */
    projectId: string | null;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeDocumentDetailDto
     */
    teamSlug: string | null;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeDocumentDetailDto
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeDocumentDetailDto
     */
    whenToRead: string;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeDocumentDetailDto
     */
    bodyBytes: number;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeDocumentDetailDto
     */
    status: KnowledgeDocumentDetailDtoStatusEnum;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeDocumentDetailDto
     */
    rev: number;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeDocumentDetailDto
     */
    pending: number;
    /**
     * 
     * @type {KnowledgeHeadSource}
     * @memberof KnowledgeDocumentDetailDto
     */
    source: KnowledgeHeadSource;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeDocumentDetailDto
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeDocumentDetailDto
     */
    updatedAt: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeDocumentDetailDto
     */
    lastReadAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeDocumentDetailDto
     */
    approvedAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeDocumentDetailDto
     */
    body: string;
}


/**
 * @export
 */
export const KnowledgeDocumentDetailDtoStatusEnum = {
    Proposed: 'proposed',
    Active: 'active',
    Archived: 'archived'
} as const;
export type KnowledgeDocumentDetailDtoStatusEnum = typeof KnowledgeDocumentDetailDtoStatusEnum[keyof typeof KnowledgeDocumentDetailDtoStatusEnum];

/**
 * 
 * @export
 * @interface KnowledgeExportDto
 */
export interface KnowledgeExportDto {
    /**
     * 
     * @type {string}
     * @memberof KnowledgeExportDto
     */
    markdown: string;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeExportDto
     */
    count: number;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeExportDto
     */
    name: string;
}
/**
 * 
 * @export
 * @interface KnowledgeHead
 */
export interface KnowledgeHead {
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHead
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHead
     */
    handle: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHead
     */
    place: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHead
     */
    projectId: string | null;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHead
     */
    teamSlug: string | null;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHead
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHead
     */
    whenToRead: string;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeHead
     */
    bodyBytes: number;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHead
     */
    status: KnowledgeHeadStatusEnum;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeHead
     */
    rev: number;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeHead
     */
    pending: number;
    /**
     * 
     * @type {KnowledgeHeadSource}
     * @memberof KnowledgeHead
     */
    source: KnowledgeHeadSource;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHead
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHead
     */
    updatedAt: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHead
     */
    lastReadAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHead
     */
    approvedAt: string | null;
}


/**
 * @export
 */
export const KnowledgeHeadStatusEnum = {
    Proposed: 'proposed',
    Active: 'active',
    Archived: 'archived'
} as const;
export type KnowledgeHeadStatusEnum = typeof KnowledgeHeadStatusEnum[keyof typeof KnowledgeHeadStatusEnum];

/**
 * 
 * @export
 * @interface KnowledgeHeadSource
 */
export interface KnowledgeHeadSource {
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHeadSource
     */
    actor: KnowledgeHeadSourceActorEnum;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHeadSource
     */
    runId: string | null;
    /**
     * 
     * @type {AgentKind}
     * @memberof KnowledgeHeadSource
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeHeadSource
     */
    model: string | null;
}


/**
 * @export
 */
export const KnowledgeHeadSourceActorEnum = {
    User: 'user',
    Agent: 'agent',
    Analysis: 'analysis'
} as const;
export type KnowledgeHeadSourceActorEnum = typeof KnowledgeHeadSourceActorEnum[keyof typeof KnowledgeHeadSourceActorEnum];

/**
 * 
 * @export
 * @interface KnowledgeListDto
 */
export interface KnowledgeListDto {
    /**
     * 
     * @type {Array<KnowledgeHead>}
     * @memberof KnowledgeListDto
     */
    documents: Array<KnowledgeHead>;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeListDto
     */
    next: string | null;
}
/**
 * 
 * @export
 * @interface KnowledgeRemovedDto
 */
export interface KnowledgeRemovedDto {
    /**
     * 
     * @type {boolean}
     * @memberof KnowledgeRemovedDto
     */
    deleted: boolean;
}
/**
 * 
 * @export
 * @interface KnowledgeRevisionDetailDto
 */
export interface KnowledgeRevisionDetailDto {
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionDetailDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionDetailDto
     */
    documentId: string;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeRevisionDetailDto
     */
    rev: number | null;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionDetailDto
     */
    status: KnowledgeRevisionDetailDtoStatusEnum;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeRevisionDetailDto
     */
    baseRev: number;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionDetailDto
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionDetailDto
     */
    whenToRead: string;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeRevisionDetailDto
     */
    bodyBytes: number;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionDetailDto
     */
    reason: string | null;
    /**
     * 
     * @type {KnowledgeRevisionDetailDtoSource}
     * @memberof KnowledgeRevisionDetailDto
     */
    source: KnowledgeRevisionDetailDtoSource;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionDetailDto
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionDetailDto
     */
    decidedAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionDetailDto
     */
    body: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionDetailDto
     */
    diff: string;
    /**
     * 
     * @type {boolean}
     * @memberof KnowledgeRevisionDetailDto
     */
    stale: boolean;
    /**
     * 
     * @type {boolean}
     * @memberof KnowledgeRevisionDetailDto
     */
    baseKept: boolean;
    /**
     * 
     * @type {KnowledgeHead}
     * @memberof KnowledgeRevisionDetailDto
     */
    document: KnowledgeHead;
}


/**
 * @export
 */
export const KnowledgeRevisionDetailDtoStatusEnum = {
    Applied: 'applied',
    Pending: 'pending',
    Rejected: 'rejected'
} as const;
export type KnowledgeRevisionDetailDtoStatusEnum = typeof KnowledgeRevisionDetailDtoStatusEnum[keyof typeof KnowledgeRevisionDetailDtoStatusEnum];

/**
 * 
 * @export
 * @interface KnowledgeRevisionDetailDtoSource
 */
export interface KnowledgeRevisionDetailDtoSource {
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionDetailDtoSource
     */
    actor: KnowledgeRevisionDetailDtoSourceActorEnum;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionDetailDtoSource
     */
    runId: string | null;
    /**
     * 
     * @type {AgentKind}
     * @memberof KnowledgeRevisionDetailDtoSource
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionDetailDtoSource
     */
    model: string | null;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionDetailDtoSource
     */
    memberId: string | null;
}


/**
 * @export
 */
export const KnowledgeRevisionDetailDtoSourceActorEnum = {
    User: 'user',
    Agent: 'agent',
    Analysis: 'analysis'
} as const;
export type KnowledgeRevisionDetailDtoSourceActorEnum = typeof KnowledgeRevisionDetailDtoSourceActorEnum[keyof typeof KnowledgeRevisionDetailDtoSourceActorEnum];

/**
 * 
 * @export
 * @interface KnowledgeRevisionHead
 */
export interface KnowledgeRevisionHead {
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionHead
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionHead
     */
    documentId: string;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeRevisionHead
     */
    rev: number | null;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionHead
     */
    status: KnowledgeRevisionHeadStatusEnum;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeRevisionHead
     */
    baseRev: number;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionHead
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionHead
     */
    whenToRead: string;
    /**
     * 
     * @type {number}
     * @memberof KnowledgeRevisionHead
     */
    bodyBytes: number;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionHead
     */
    reason: string | null;
    /**
     * 
     * @type {KnowledgeRevisionDetailDtoSource}
     * @memberof KnowledgeRevisionHead
     */
    source: KnowledgeRevisionDetailDtoSource;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionHead
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof KnowledgeRevisionHead
     */
    decidedAt: string | null;
}


/**
 * @export
 */
export const KnowledgeRevisionHeadStatusEnum = {
    Applied: 'applied',
    Pending: 'pending',
    Rejected: 'rejected'
} as const;
export type KnowledgeRevisionHeadStatusEnum = typeof KnowledgeRevisionHeadStatusEnum[keyof typeof KnowledgeRevisionHeadStatusEnum];

/**
 * 
 * @export
 * @interface KnowledgeRevisionListDto
 */
export interface KnowledgeRevisionListDto {
    /**
     * 
     * @type {Array<KnowledgeRevisionHead>}
     * @memberof KnowledgeRevisionListDto
     */
    revisions: Array<KnowledgeRevisionHead>;
}
/**
 * 
 * @export
 * @interface KnowledgeRunSearchDto
 */
export interface KnowledgeRunSearchDto {
    /**
     * 
     * @type {Array<KnowledgeHead>}
     * @memberof KnowledgeRunSearchDto
     */
    documents: Array<KnowledgeHead>;
}
/**
 * 
 * @export
 * @interface LabelInstructionDeletedDto
 */
export interface LabelInstructionDeletedDto {
    /**
     * 
     * @type {boolean}
     * @memberof LabelInstructionDeletedDto
     */
    deleted: boolean;
}
/**
 * 
 * @export
 * @interface LabelInstructionDto
 */
export interface LabelInstructionDto {
    /**
     * 
     * @type {string}
     * @memberof LabelInstructionDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof LabelInstructionDto
     */
    projectId: string | null;
    /**
     * 
     * @type {string}
     * @memberof LabelInstructionDto
     */
    label: string;
    /**
     * 
     * @type {string}
     * @memberof LabelInstructionDto
     */
    instructions: string;
    /**
     * 
     * @type {string}
     * @memberof LabelInstructionDto
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof LabelInstructionDto
     */
    updatedAt: string;
}
/**
 * 
 * @export
 * @interface LessonDedup
 */
export interface LessonDedup {
    /**
     * 
     * @type {string}
     * @memberof LessonDedup
     */
    verdict: LessonDedupVerdictEnum;
    /**
     * 
     * @type {string}
     * @memberof LessonDedup
     */
    handle: string | null;
}


/**
 * @export
 */
export const LessonDedupVerdictEnum = {
    New: 'new',
    Refines: 'refines',
    BrokenAgain: 'broken_again'
} as const;
export type LessonDedupVerdictEnum = typeof LessonDedupVerdictEnum[keyof typeof LessonDedupVerdictEnum];

/**
 * 
 * @export
 * @interface LessonEstimate
 */
export interface LessonEstimate {
    /**
     * 
     * @type {AgentKind}
     * @memberof LessonEstimate
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof LessonEstimate
     */
    model: string | null;
    /**
     * 
     * @type {number}
     * @memberof LessonEstimate
     */
    tokens: number;
    /**
     * 
     * @type {number}
     * @memberof LessonEstimate
     */
    usd: number | null;
}


/**
 * 
 * @export
 * @interface LessonEvidence
 */
export interface LessonEvidence {
    /**
     * 
     * @type {number}
     * @memberof LessonEvidence
     */
    seq: number;
    /**
     * 
     * @type {string}
     * @memberof LessonEvidence
     */
    quote: string;
}
/**
 * 
 * @export
 * @interface LessonKnowledgeTarget
 */
export interface LessonKnowledgeTarget {
    /**
     * 
     * @type {string}
     * @memberof LessonKnowledgeTarget
     */
    kind: LessonKnowledgeTargetKindEnum;
    /**
     * 
     * @type {string}
     * @memberof LessonKnowledgeTarget
     */
    handle: string | null;
}


/**
 * @export
 */
export const LessonKnowledgeTargetKindEnum = {
    Knowledge: 'knowledge'
} as const;
export type LessonKnowledgeTargetKindEnum = typeof LessonKnowledgeTargetKindEnum[keyof typeof LessonKnowledgeTargetKindEnum];

/**
 * 
 * @export
 * @interface LessonMemberInstructionsTarget
 */
export interface LessonMemberInstructionsTarget {
    /**
     * 
     * @type {string}
     * @memberof LessonMemberInstructionsTarget
     */
    kind: LessonMemberInstructionsTargetKindEnum;
    /**
     * 
     * @type {string}
     * @memberof LessonMemberInstructionsTarget
     */
    memberId: string;
}


/**
 * @export
 */
export const LessonMemberInstructionsTargetKindEnum = {
    MemberInstructions: 'member_instructions'
} as const;
export type LessonMemberInstructionsTargetKindEnum = typeof LessonMemberInstructionsTargetKindEnum[keyof typeof LessonMemberInstructionsTargetKindEnum];

/**
 * 
 * @export
 * @interface LessonMemoryTarget
 */
export interface LessonMemoryTarget {
    /**
     * 
     * @type {string}
     * @memberof LessonMemoryTarget
     */
    kind: LessonMemoryTargetKindEnum;
    /**
     * 
     * @type {string}
     * @memberof LessonMemoryTarget
     */
    scope: LessonMemoryTargetScopeEnum;
    /**
     * 
     * @type {string}
     * @memberof LessonMemoryTarget
     */
    type: LessonMemoryTargetTypeEnum;
}


/**
 * @export
 */
export const LessonMemoryTargetKindEnum = {
    Memory: 'memory'
} as const;
export type LessonMemoryTargetKindEnum = typeof LessonMemoryTargetKindEnum[keyof typeof LessonMemoryTargetKindEnum];

/**
 * @export
 */
export const LessonMemoryTargetScopeEnum = {
    Project: 'project',
    Team: 'team',
    Global: 'global'
} as const;
export type LessonMemoryTargetScopeEnum = typeof LessonMemoryTargetScopeEnum[keyof typeof LessonMemoryTargetScopeEnum];

/**
 * @export
 */
export const LessonMemoryTargetTypeEnum = {
    User: 'user',
    Feedback: 'feedback',
    Project: 'project',
    Reference: 'reference'
} as const;
export type LessonMemoryTargetTypeEnum = typeof LessonMemoryTargetTypeEnum[keyof typeof LessonMemoryTargetTypeEnum];

/**
 * 
 * @export
 * @interface LessonModelChoice
 */
export interface LessonModelChoice {
    /**
     * An agent kind; one this daemon does not know is ignored
     * @type {string}
     * @memberof LessonModelChoice
     */
    agent: string;
    /**
     * 
     * @type {string}
     * @memberof LessonModelChoice
     */
    configDir: string | null;
    /**
     * 
     * @type {string}
     * @memberof LessonModelChoice
     */
    model: string | null;
    /**
     * 
     * @type {string}
     * @memberof LessonModelChoice
     */
    effort: string | null;
    /**
     * 
     * @type {string}
     * @memberof LessonModelChoice
     */
    contextWindow: string | null;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof LessonModelChoice
     */
    modelParameters: { [key: string]: string; };
}

/**
 * 
 * @export
 */
export const LessonOverride = {
    On: 'on',
    Off: 'off'
} as const;
export type LessonOverride = typeof LessonOverride[keyof typeof LessonOverride];

/**
 * 
 * @export
 * @interface LessonPlaceMember
 */
export interface LessonPlaceMember {
    /**
     * 
     * @type {string}
     * @memberof LessonPlaceMember
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof LessonPlaceMember
     */
    name: string;
}
/**
 * 
 * @export
 * @interface LessonPlaces
 */
export interface LessonPlaces {
    /**
     * 
     * @type {boolean}
     * @memberof LessonPlaces
     */
    project: boolean;
    /**
     * 
     * @type {boolean}
     * @memberof LessonPlaces
     */
    team: boolean;
    /**
     * 
     * @type {string}
     * @memberof LessonPlaces
     */
    projectId: string | null;
    /**
     * 
     * @type {Array<LessonPlaceMember>}
     * @memberof LessonPlaces
     */
    members: Array<LessonPlaceMember>;
}
/**
 * 
 * @export
 * @interface LessonProjectInstructionsTarget
 */
export interface LessonProjectInstructionsTarget {
    /**
     * 
     * @type {string}
     * @memberof LessonProjectInstructionsTarget
     */
    kind: LessonProjectInstructionsTargetKindEnum;
}


/**
 * @export
 */
export const LessonProjectInstructionsTargetKindEnum = {
    ProjectInstructions: 'project_instructions'
} as const;
export type LessonProjectInstructionsTargetKindEnum = typeof LessonProjectInstructionsTargetKindEnum[keyof typeof LessonProjectInstructionsTargetKindEnum];

/**
 * 
 * @export
 * @interface LessonProposal
 */
export interface LessonProposal {
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    sourceRunId: string;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    sourceTitle: string | null;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    reflectionRunId: string;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    projectId: string | null;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    teamSlug: string | null;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    rule: string;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    why: string;
    /**
     * 
     * @type {LessonSignalKind}
     * @memberof LessonProposal
     */
    signalKind: LessonSignalKind;
    /**
     * 
     * @type {LessonEvidence}
     * @memberof LessonProposal
     */
    evidence: LessonEvidence;
    /**
     * 
     * @type {LessonTarget}
     * @memberof LessonProposal
     */
    target: LessonTarget;
    /**
     * 
     * @type {LessonDedup}
     * @memberof LessonProposal
     */
    dedup: LessonDedup;
    /**
     * 
     * @type {LessonProposalStatus}
     * @memberof LessonProposal
     */
    status: LessonProposalStatus;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    rejectReason: string | null;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    checkVerdict: LessonProposalCheckVerdictEnum | null;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    checkReason: string | null;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    memoryHandle: string | null;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    resultRef: string | null;
    /**
     * 
     * @type {LessonPlaces}
     * @memberof LessonProposal
     */
    places: LessonPlaces;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    moveUp: LessonProposalMoveUpEnum | null;
    /**
     * Saved to memory as an entry of its own, so Undo and Edit apply
     * @type {boolean}
     * @memberof LessonProposal
     */
    undoable: boolean;
    /**
     * False once the thread the lesson came from was deleted
     * @type {boolean}
     * @memberof LessonProposal
     */
    sourceExists: boolean;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof LessonProposal
     */
    decidedAt: string | null;
}


/**
 * @export
 */
export const LessonProposalCheckVerdictEnum = {
    Keep: 'keep',
    Rewrite: 'rewrite',
    Drop: 'drop'
} as const;
export type LessonProposalCheckVerdictEnum = typeof LessonProposalCheckVerdictEnum[keyof typeof LessonProposalCheckVerdictEnum];

/**
 * @export
 */
export const LessonProposalMoveUpEnum = {
    MemoryIndex: 'memory_index'
} as const;
export type LessonProposalMoveUpEnum = typeof LessonProposalMoveUpEnum[keyof typeof LessonProposalMoveUpEnum];

/**
 * 
 * @export
 * @interface LessonProposalListDto
 */
export interface LessonProposalListDto {
    /**
     * 
     * @type {Array<LessonProposal>}
     * @memberof LessonProposalListDto
     */
    proposals: Array<LessonProposal>;
}

/**
 * 
 * @export
 */
export const LessonProposalStatus = {
    Proposed: 'proposed',
    Checking: 'checking',
    Saved: 'saved',
    SkippedDuplicate: 'skipped_duplicate',
    Undone: 'undone',
    DroppedByCheck: 'dropped_by_check',
    CheckFailed: 'check_failed',
    Rejected: 'rejected',
    Failed: 'failed'
} as const;
export type LessonProposalStatus = typeof LessonProposalStatus[keyof typeof LessonProposalStatus];

/**
 * 
 * @export
 * @interface LessonReflectionFactsDto
 */
export interface LessonReflectionFactsDto {
    /**
     * 
     * @type {string}
     * @memberof LessonReflectionFactsDto
     */
    reflectionRunId: string;
    /**
     * 
     * @type {AgentKind}
     * @memberof LessonReflectionFactsDto
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof LessonReflectionFactsDto
     */
    model: string | null;
    /**
     * 
     * @type {string}
     * @memberof LessonReflectionFactsDto
     */
    effort: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof LessonReflectionFactsDto
     */
    working: boolean;
    /**
     * 
     * @type {string}
     * @memberof LessonReflectionFactsDto
     */
    startedAt: string;
    /**
     * 
     * @type {number}
     * @memberof LessonReflectionFactsDto
     */
    durationMs: number | null;
    /**
     * 
     * @type {number}
     * @memberof LessonReflectionFactsDto
     */
    costUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof LessonReflectionFactsDto
     */
    tokens: number | null;
}


/**
 * 
 * @export
 * @interface LessonSegment
 */
export interface LessonSegment {
    /**
     * 
     * @type {string}
     * @memberof LessonSegment
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof LessonSegment
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof LessonSegment
     */
    sourceTitle: string | null;
    /**
     * 
     * @type {number}
     * @memberof LessonSegment
     */
    fromSeq: number;
    /**
     * 
     * @type {number}
     * @memberof LessonSegment
     */
    toSeq: number;
    /**
     * 
     * @type {LessonSegmentCloser}
     * @memberof LessonSegment
     */
    closedBy: LessonSegmentCloser;
    /**
     * 
     * @type {string}
     * @memberof LessonSegment
     */
    closedAt: string;
    /**
     * 
     * @type {Array<LessonSignalRef>}
     * @memberof LessonSegment
     */
    signals: Array<LessonSignalRef>;
    /**
     * 
     * @type {LessonSegmentStatus}
     * @memberof LessonSegment
     */
    status: LessonSegmentStatus;
    /**
     * 
     * @type {string}
     * @memberof LessonSegment
     */
    reflectionRunId: string | null;
    /**
     * 
     * @type {string}
     * @memberof LessonSegment
     */
    checkRunId: string | null;
    /**
     * 
     * @type {string}
     * @memberof LessonSegment
     */
    failReason: string | null;
    /**
     * 
     * @type {LessonEstimate}
     * @memberof LessonSegment
     */
    estimate: LessonEstimate;
    /**
     * 
     * @type {LessonEstimate}
     * @memberof LessonSegment
     */
    checkEstimate: LessonEstimate | null;
}



/**
 * 
 * @export
 */
export const LessonSegmentCloser = {
    Manual: 'manual',
    Archive: 'archive',
    Delete: 'delete'
} as const;
export type LessonSegmentCloser = typeof LessonSegmentCloser[keyof typeof LessonSegmentCloser];

/**
 * 
 * @export
 * @interface LessonSegmentListDto
 */
export interface LessonSegmentListDto {
    /**
     * 
     * @type {Array<LessonSegment>}
     * @memberof LessonSegmentListDto
     */
    segments: Array<LessonSegment>;
}

/**
 * 
 * @export
 */
export const LessonSegmentStatus = {
    Queued: 'queued',
    Reflecting: 'reflecting',
    Checking: 'checking',
    Reflected: 'reflected',
    Failed: 'failed',
    Empty: 'empty',
    Skipped: 'skipped'
} as const;
export type LessonSegmentStatus = typeof LessonSegmentStatus[keyof typeof LessonSegmentStatus];


/**
 * 
 * @export
 */
export const LessonSignalKind = {
    UserCorrection: 'user_correction',
    ApprovalRefused: 'approval_refused',
    ErrorThenSuccess: 'error_then_success',
    OutcomeFailed: 'outcome_failed',
    StageReopened: 'stage_reopened',
    ReviewFinding: 'review_finding'
} as const;
export type LessonSignalKind = typeof LessonSignalKind[keyof typeof LessonSignalKind];

/**
 * 
 * @export
 * @interface LessonSignalRef
 */
export interface LessonSignalRef {
    /**
     * 
     * @type {LessonSignalKind}
     * @memberof LessonSignalRef
     */
    kind: LessonSignalKind;
    /**
     * 
     * @type {number}
     * @memberof LessonSignalRef
     */
    seq: number;
}


/**
 * 
 * @export
 * @interface LessonSpendByStep
 */
export interface LessonSpendByStep {
    /**
     * 
     * @type {number}
     * @memberof LessonSpendByStep
     */
    reflect: number;
    /**
     * 
     * @type {number}
     * @memberof LessonSpendByStep
     */
    check: number;
}
/**
 * @type LessonTarget
 * 
 * @export
 */
export type LessonTarget = LessonKnowledgeTarget | LessonMemberInstructionsTarget | LessonMemoryTarget | LessonProjectInstructionsTarget;
/**
 * 
 * @export
 * @interface LessonsConfigAckDto
 */
export interface LessonsConfigAckDto {
    /**
     * 
     * @type {string}
     * @memberof LessonsConfigAckDto
     */
    mode: LessonsConfigAckDtoModeEnum;
    /**
     * 
     * @type {LessonModelChoice}
     * @memberof LessonsConfigAckDto
     */
    reflector: LessonModelChoice | null;
    /**
     * 
     * @type {LessonModelChoice}
     * @memberof LessonsConfigAckDto
     */
    checker: LessonModelChoice | null;
}


/**
 * @export
 */
export const LessonsConfigAckDtoModeEnum = {
    Off: 'off',
    Auto: 'auto'
} as const;
export type LessonsConfigAckDtoModeEnum = typeof LessonsConfigAckDtoModeEnum[keyof typeof LessonsConfigAckDtoModeEnum];

/**
 * 
 * @export
 * @interface LessonsConfigDto
 */
export interface LessonsConfigDto {
    /**
     * 
     * @type {string}
     * @memberof LessonsConfigDto
     */
    mode: LessonsConfigDtoModeEnum;
    /**
     * 
     * @type {LessonModelChoice}
     * @memberof LessonsConfigDto
     */
    reflector: LessonModelChoice | null;
    /**
     * 
     * @type {LessonModelChoice}
     * @memberof LessonsConfigDto
     */
    checker: LessonModelChoice | null;
}


/**
 * @export
 */
export const LessonsConfigDtoModeEnum = {
    Off: 'off',
    Auto: 'auto'
} as const;
export type LessonsConfigDtoModeEnum = typeof LessonsConfigDtoModeEnum[keyof typeof LessonsConfigDtoModeEnum];

/**
 * 
 * @export
 * @interface LessonsReflectStartedDto
 */
export interface LessonsReflectStartedDto {
    /**
     * 
     * @type {string}
     * @memberof LessonsReflectStartedDto
     */
    reflectionRunId: string;
    /**
     * 
     * @type {string}
     * @memberof LessonsReflectStartedDto
     */
    segmentId: string;
    /**
     * 
     * @type {number}
     * @memberof LessonsReflectStartedDto
     */
    fromSeq: number;
    /**
     * 
     * @type {number}
     * @memberof LessonsReflectStartedDto
     */
    toSeq: number;
}
/**
 * 
 * @export
 * @interface LessonsSpendDto
 */
export interface LessonsSpendDto {
    /**
     * 
     * @type {number}
     * @memberof LessonsSpendDto
     */
    todayUsd: number;
    /**
     * 
     * @type {number}
     * @memberof LessonsSpendDto
     */
    monthUsd: number;
    /**
     * 
     * @type {LessonSpendByStep}
     * @memberof LessonsSpendDto
     */
    todayByStep: LessonSpendByStep;
    /**
     * 
     * @type {LessonSpendByStep}
     * @memberof LessonsSpendDto
     */
    monthByStep: LessonSpendByStep;
    /**
     * Threads reflected on today
     * @type {number}
     * @memberof LessonsSpendDto
     */
    reflectedToday: number;
    /**
     * Lessons saved to memory today
     * @type {number}
     * @memberof LessonsSpendDto
     */
    savedToday: number;
    /**
     * Reflections or checks this month whose CLI reported no cost
     * @type {number}
     * @memberof LessonsSpendDto
     */
    unpricedRuns: number;
    /**
     * 
     * @type {Array<LessonsSpendDtoFailedInner>}
     * @memberof LessonsSpendDto
     */
    failed: Array<LessonsSpendDtoFailedInner>;
}
/**
 * 
 * @export
 * @interface LessonsSpendDtoFailedInner
 */
export interface LessonsSpendDtoFailedInner {
    /**
     * 
     * @type {string}
     * @memberof LessonsSpendDtoFailedInner
     */
    segmentId: string;
    /**
     * 
     * @type {string}
     * @memberof LessonsSpendDtoFailedInner
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof LessonsSpendDtoFailedInner
     */
    sourceTitle: string | null;
    /**
     * 
     * @type {string}
     * @memberof LessonsSpendDtoFailedInner
     */
    reason: string | null;
}
/**
 * 
 * @export
 * @interface LineBaselineDto
 */
export interface LineBaselineDto {
    /**
     * 
     * @type {string}
     * @memberof LineBaselineDto
     */
    baseSha: string | null;
}
/**
 * 
 * @export
 * @interface LineBaselineRequestDto
 */
export interface LineBaselineRequestDto {
    /**
     * the thread about to be measured
     * @type {string}
     * @memberof LineBaselineRequestDto
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof LineBaselineRequestDto
     */
    branch: string | null;
    /**
     * the repository the thread’s folder belongs to, as git names its top level
     * @type {string}
     * @memberof LineBaselineRequestDto
     */
    root: string;
    /**
     * a baseline the folder can no longer be measured from (its commit is gone, or the checkout no longer descends from it); replaced by this thread’s start commit
     * @type {string}
     * @memberof LineBaselineRequestDto
     */
    staleBaseSha?: string;
}
/**
 * 
 * @export
 * @interface LineSnapshotAckDto
 */
export interface LineSnapshotAckDto {
    /**
     * 
     * @type {boolean}
     * @memberof LineSnapshotAckDto
     */
    recorded: LineSnapshotAckDtoRecordedEnum;
}


/**
 * @export
 */
export const LineSnapshotAckDtoRecordedEnum = {
    True: true
} as const;
export type LineSnapshotAckDtoRecordedEnum = typeof LineSnapshotAckDtoRecordedEnum[keyof typeof LineSnapshotAckDtoRecordedEnum];

/**
 * 
 * @export
 * @interface LineSnapshotDto
 */
export interface LineSnapshotDto {
    /**
     * the thread whose finished turn the measurement follows
     * @type {string}
     * @memberof LineSnapshotDto
     */
    runId: string;
    /**
     * the folder baseline the totals were measured against (`POST /v1/stats/line-baselines`); absent, the totals are the thread’s own and are counted per thread
     * @type {string}
     * @memberof LineSnapshotDto
     */
    baseSha?: string;
    /**
     * 
     * @type {string}
     * @memberof LineSnapshotDto
     */
    branch?: string | null;
    /**
     * the repository the folder belongs to, as its baseline was resolved for. Required with `baseSha`
     * @type {string}
     * @memberof LineSnapshotDto
     */
    root?: string;
    /**
     * lines added against the baseline, cumulative
     * @type {number}
     * @memberof LineSnapshotDto
     */
    linesAdded: number;
    /**
     * lines removed against the baseline, cumulative
     * @type {number}
     * @memberof LineSnapshotDto
     */
    linesRemoved: number;
    /**
     * true when the count is a lower bound: a listing was truncated, or some files were not counted
     * @type {boolean}
     * @memberof LineSnapshotDto
     */
    partial: boolean;
    /**
     * when the measurement was taken; the time the daemon received it when omitted
     * @type {string}
     * @memberof LineSnapshotDto
     */
    occurredAt?: string;
}
/**
 * 
 * @export
 * @interface LiveAction
 */
export interface LiveAction {
    /**
     * the publish row — what a press addresses
     * @type {number}
     * @memberof LiveAction
     */
    seq: number;
    /**
     * 
     * @type {string}
     * @memberof LiveAction
     */
    actionId: string;
    /**
     * 
     * @type {string}
     * @memberof LiveAction
     */
    memberId: string;
    /**
     * 
     * @type {string}
     * @memberof LiveAction
     */
    conversationId: string;
    /**
     * 
     * @type {string}
     * @memberof LiveAction
     */
    label: string;
    /**
     * 
     * @type {string}
     * @memberof LiveAction
     */
    description?: string;
    /**
     * 
     * @type {boolean}
     * @memberof LiveAction
     */
    once: boolean;
    /**
     * 
     * @type {ActionSpec}
     * @memberof LiveAction
     */
    spec: ActionSpec;
    /**
     * 
     * @type {ActionPublisher}
     * @memberof LiveAction
     */
    publisher: ActionPublisher;
    /**
     * a press is under way
     * @type {boolean}
     * @memberof LiveAction
     */
    pending: boolean;
    /**
     * 
     * @type {ActionOutcomePayload}
     * @memberof LiveAction
     */
    lastOutcome?: ActionOutcomePayload;
}
/**
 * 
 * @export
 * @interface LocalImageDto
 */
export interface LocalImageDto {
    /**
     * the reference exactly as the agent wrote it — the renderer’s cache key
     * @type {string}
     * @memberof LocalImageDto
     */
    path: string;
    /**
     * 
     * @type {AttachmentMediaType}
     * @memberof LocalImageDto
     */
    mediaType: AttachmentMediaType;
    /**
     * base64-encoded image bytes
     * @type {string}
     * @memberof LocalImageDto
     */
    data: string;
}


/**
 * 
 * @export
 * @interface LoginCodeBodyDto
 */
export interface LoginCodeBodyDto {
    /**
     * 
     * @type {string}
     * @memberof LoginCodeBodyDto
     */
    code: string;
}
/**
 * 
 * @export
 * @interface LoginSessionDto
 */
export interface LoginSessionDto {
    /**
     * 
     * @type {string}
     * @memberof LoginSessionDto
     */
    id: string;
    /**
     * 
     * @type {AgentKind}
     * @memberof LoginSessionDto
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof LoginSessionDto
     */
    status: LoginSessionDtoStatusEnum;
    /**
     * 
     * @type {string}
     * @memberof LoginSessionDto
     */
    url: string | null;
    /**
     * 
     * @type {string}
     * @memberof LoginSessionDto
     */
    message: string | null;
}


/**
 * @export
 */
export const LoginSessionDtoStatusEnum = {
    Waiting: 'waiting',
    NeedsCode: 'needs_code',
    Verifying: 'verifying',
    Succeeded: 'succeeded',
    Failed: 'failed',
    Cancelled: 'cancelled'
} as const;
export type LoginSessionDtoStatusEnum = typeof LoginSessionDtoStatusEnum[keyof typeof LoginSessionDtoStatusEnum];

/**
 * 
 * @export
 * @interface LogoutResultDto
 */
export interface LogoutResultDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof LogoutResultDto
     */
    agent: AgentKind;
    /**
     * 
     * @type {boolean}
     * @memberof LogoutResultDto
     */
    ok: boolean;
    /**
     * 
     * @type {string}
     * @memberof LogoutResultDto
     */
    unavailableReason: string | null;
}


/**
 * 
 * @export
 * @interface McpServerUse
 */
export interface McpServerUse {
    /**
     * 
     * @type {string}
     * @memberof McpServerUse
     */
    server: string;
    /**
     * 
     * @type {number}
     * @memberof McpServerUse
     */
    calls: number;
    /**
     * 
     * @type {number}
     * @memberof McpServerUse
     */
    errors: number;
    /**
     * distinct tools of it that were called
     * @type {number}
     * @memberof McpServerUse
     */
    tools: number;
}
/**
 * 
 * @export
 * @interface MeasureInstructionSizesDto
 */
export interface MeasureInstructionSizesDto {
    /**
     * 
     * @type {Team}
     * @memberof MeasureInstructionSizesDto
     */
    team: Team;
    /**
     * 
     * @type {string}
     * @memberof MeasureInstructionSizesDto
     */
    customInstructions?: string;
    /**
     * 
     * @type {string}
     * @memberof MeasureInstructionSizesDto
     */
    replyLanguage?: string;
    /**
     * With `overlay`: measure the team as this project runs it
     * @type {string}
     * @memberof MeasureInstructionSizesDto
     */
    projectId?: string;
    /**
     * The project's overlay as the editor holds it, applied to `team` before measuring
     * @type {TeamOverlay}
     * @memberof MeasureInstructionSizesDto
     */
    overlay?: TeamOverlay;
}
/**
 * 
 * @export
 * @interface MeasureProjectInstructionSizesDto
 */
export interface MeasureProjectInstructionSizesDto {
    /**
     * 
     * @type {string}
     * @memberof MeasureProjectInstructionSizesDto
     */
    customInstructions?: string;
    /**
     * 
     * @type {string}
     * @memberof MeasureProjectInstructionSizesDto
     */
    replyLanguage?: string;
}
/**
 * 
 * @export
 * @interface MemberAssessmentEntry
 */
export interface MemberAssessmentEntry {
    /**
     * the chat that filed it — it may be gone
     * @type {string}
     * @memberof MemberAssessmentEntry
     */
    chatRunId: string;
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentEntry
     */
    chatKind: MemberAssessmentEntryChatKindEnum;
    /**
     * 
     * @type {number}
     * @memberof MemberAssessmentEntry
     */
    cardSeq: number;
    /**
     * ISO-8601
     * @type {string}
     * @memberof MemberAssessmentEntry
     */
    filedAt: string;
    /**
     * how many runs the analysis read
     * @type {number}
     * @memberof MemberAssessmentEntry
     */
    runs: number;
    /**
     * the team versions the analysed runs ran, oldest first — what the marks describe
     * @type {Array<MemberChangeFrom>}
     * @memberof MemberAssessmentEntry
     */
    versions: Array<MemberChangeFrom>;
    /**
     * 
     * @type {number}
     * @memberof MemberAssessmentEntry
     */
    usefulness: number | null;
    /**
     * 
     * @type {number}
     * @memberof MemberAssessmentEntry
     */
    quality: number | null;
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentEntry
     */
    verdict: MemberAssessmentEntryVerdictEnum;
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentEntry
     */
    summary: string;
    /**
     * 
     * @type {Array<MemberAssessmentEntryEvidenceInner>}
     * @memberof MemberAssessmentEntry
     */
    evidence: Array<MemberAssessmentEntryEvidenceInner>;
    /**
     * the card items that carry the verdict out
     * @type {Array<MemberAssessmentEntryItemsInner>}
     * @memberof MemberAssessmentEntry
     */
    items: Array<MemberAssessmentEntryItemsInner>;
    /**
     * 
     * @type {MemberAssessmentEntryJudge}
     * @memberof MemberAssessmentEntry
     */
    judge: MemberAssessmentEntryJudge;
    /**
     * 
     * @type {MemberAssessmentUserVerdict}
     * @memberof MemberAssessmentEntry
     */
    userVerdict: MemberAssessmentUserVerdict | null;
}


/**
 * @export
 */
export const MemberAssessmentEntryChatKindEnum = {
    Analysis: 'analysis',
    Builder: 'builder',
    Thread: 'thread'
} as const;
export type MemberAssessmentEntryChatKindEnum = typeof MemberAssessmentEntryChatKindEnum[keyof typeof MemberAssessmentEntryChatKindEnum];

/**
 * @export
 */
export const MemberAssessmentEntryVerdictEnum = {
    Keep: 'keep',
    Tune: 'tune',
    Reconfigure: 'reconfigure',
    Replace: 'replace',
    Remove: 'remove'
} as const;
export type MemberAssessmentEntryVerdictEnum = typeof MemberAssessmentEntryVerdictEnum[keyof typeof MemberAssessmentEntryVerdictEnum];

/**
 * 
 * @export
 * @interface MemberAssessmentEntryEvidenceInner
 */
export interface MemberAssessmentEntryEvidenceInner {
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentEntryEvidenceInner
     */
    runId: string | null;
    /**
     * 
     * @type {number}
     * @memberof MemberAssessmentEntryEvidenceInner
     */
    seq: number;
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentEntryEvidenceInner
     */
    quote: string;
}
/**
 * 
 * @export
 * @interface MemberAssessmentEntryItemsInner
 */
export interface MemberAssessmentEntryItemsInner {
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentEntryItemsInner
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentEntryItemsInner
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentEntryItemsInner
     */
    status: MemberAssessmentEntryItemsInnerStatusEnum | null;
}


/**
 * @export
 */
export const MemberAssessmentEntryItemsInnerStatusEnum = {
    Applied: 'applied',
    Skipped: 'skipped',
    Failed: 'failed',
    Selected: 'selected',
    Open: 'open',
    NotSelected: 'not-selected',
    Unanswered: 'unanswered'
} as const;
export type MemberAssessmentEntryItemsInnerStatusEnum = typeof MemberAssessmentEntryItemsInnerStatusEnum[keyof typeof MemberAssessmentEntryItemsInnerStatusEnum];

/**
 * the CLI and model of the chat that marked it
 * @export
 * @interface MemberAssessmentEntryJudge
 */
export interface MemberAssessmentEntryJudge {
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentEntryJudge
     */
    agent: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentEntryJudge
     */
    model: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof MemberAssessmentEntryJudge
     */
    sameVendor: boolean | null;
}
/**
 * 
 * @export
 * @interface MemberAssessmentUserVerdict
 */
export interface MemberAssessmentUserVerdict {
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentUserVerdict
     */
    verdict: MemberAssessmentUserVerdictVerdictEnum;
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentUserVerdict
     */
    note: string | null;
    /**
     * ISO-8601
     * @type {string}
     * @memberof MemberAssessmentUserVerdict
     */
    at: string;
}


/**
 * @export
 */
export const MemberAssessmentUserVerdictVerdictEnum = {
    Agree: 'agree',
    Disagree: 'disagree'
} as const;
export type MemberAssessmentUserVerdictVerdictEnum = typeof MemberAssessmentUserVerdictVerdictEnum[keyof typeof MemberAssessmentUserVerdictVerdictEnum];

/**
 * 
 * @export
 * @interface MemberAssessmentVerdictDto
 */
export interface MemberAssessmentVerdictDto {
    /**
     * the chat that filed the card
     * @type {string}
     * @memberof MemberAssessmentVerdictDto
     */
    chatRunId: string;
    /**
     * 
     * @type {number}
     * @memberof MemberAssessmentVerdictDto
     */
    cardSeq: number;
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentVerdictDto
     */
    memberId: string;
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentVerdictDto
     */
    verdict: MemberAssessmentVerdictDtoVerdictEnum | null;
    /**
     * 
     * @type {string}
     * @memberof MemberAssessmentVerdictDto
     */
    note?: string | null;
}


/**
 * @export
 */
export const MemberAssessmentVerdictDtoVerdictEnum = {
    Agree: 'agree',
    Disagree: 'disagree'
} as const;
export type MemberAssessmentVerdictDtoVerdictEnum = typeof MemberAssessmentVerdictDtoVerdictEnum[keyof typeof MemberAssessmentVerdictDtoVerdictEnum];

/**
 * 
 * @export
 * @interface MemberAvatar
 */
export interface MemberAvatar {
    /**
     * 
     * @type {string}
     * @memberof MemberAvatar
     */
    kind: MemberAvatarKindEnum;
    /**
     * The initials, the emoji, or the stored picture’s id
     * @type {string}
     * @memberof MemberAvatar
     */
    value?: string;
    /**
     * Colour token the avatar is drawn in
     * @type {string}
     * @memberof MemberAvatar
     */
    tone?: string;
}


/**
 * @export
 */
export const MemberAvatarKindEnum = {
    Initials: 'initials',
    Emoji: 'emoji',
    Picture: 'picture'
} as const;
export type MemberAvatarKindEnum = typeof MemberAvatarKindEnum[keyof typeof MemberAvatarKindEnum];

/**
 * 
 * @export
 * @interface MemberCall
 */
export interface MemberCall {
    /**
     * 
     * @type {string}
     * @memberof MemberCall
     */
    caller: string;
    /**
     * 
     * @type {string}
     * @memberof MemberCall
     */
    callee: string;
    /**
     * 
     * @type {number}
     * @memberof MemberCall
     */
    calls: number;
    /**
     * calls that ended without an answer
     * @type {number}
     * @memberof MemberCall
     */
    failed: number;
    /**
     * the callee's turns inside them
     * @type {number}
     * @memberof MemberCall
     */
    turns: number;
    /**
     * 
     * @type {number}
     * @memberof MemberCall
     */
    costUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof MemberCall
     */
    avgMs: number | null;
}
/**
 * 
 * @export
 * @interface MemberChange
 */
export interface MemberChange {
    /**
     * 
     * @type {MemberChangeFrom}
     * @memberof MemberChange
     */
    from: MemberChangeFrom;
    /**
     * 
     * @type {MemberChangeFrom}
     * @memberof MemberChange
     */
    to: MemberChangeFrom;
    /**
     * ISO-8601: the first run of the new version after the old
     * @type {string}
     * @memberof MemberChange
     */
    at: string;
    /**
     * what changed
     * @type {Array<string>}
     * @memberof MemberChange
     */
    kinds: Array<MemberChangeKindsEnum>;
    /**
     * 
     * @type {string}
     * @memberof MemberChange
     */
    source: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemberChange
     */
    summary: string | null;
    /**
     * 
     * @type {Array<string>}
     * @memberof MemberChange
     */
    recommendationIds: Array<string>;
    /**
     * 
     * @type {MemberVersionFigures}
     * @memberof MemberChange
     */
    before: MemberVersionFigures | null;
    /**
     * 
     * @type {MemberVersionFigures}
     * @memberof MemberChange
     */
    after: MemberVersionFigures | null;
    /**
     * 
     * @type {MemberChangeTeam}
     * @memberof MemberChange
     */
    team: MemberChangeTeam;
    /**
     * better or worse when every figure that moved by a tenth or more moved that way, mixed when they disagree; too-few-runs under two runs on either side
     * @type {string}
     * @memberof MemberChange
     */
    effect: MemberChangeEffectEnum;
    /**
     * the figures that moved by a tenth or more, and which way
     * @type {Array<MemberChangeMovedInner>}
     * @memberof MemberChange
     */
    moved: Array<MemberChangeMovedInner>;
}


/**
 * @export
 */
export const MemberChangeKindsEnum = {
    Added: 'added',
    Removed: 'removed',
    Role: 'role',
    Instructions: 'instructions',
    Character: 'character',
    Agent: 'agent',
    Model: 'model',
    Effort: 'effort',
    Approval: 'approval',
    Pool: 'pool',
    Tools: 'tools',
    Stages: 'stages',
    Blocks: 'blocks'
} as const;
export type MemberChangeKindsEnum = typeof MemberChangeKindsEnum[keyof typeof MemberChangeKindsEnum];

/**
 * @export
 */
export const MemberChangeEffectEnum = {
    Better: 'better',
    Worse: 'worse',
    Mixed: 'mixed',
    NoChange: 'no-change',
    TooFewRuns: 'too-few-runs'
} as const;
export type MemberChangeEffectEnum = typeof MemberChangeEffectEnum[keyof typeof MemberChangeEffectEnum];

/**
 * 
 * @export
 * @interface MemberChangeFrom
 */
export interface MemberChangeFrom {
    /**
     * 
     * @type {number}
     * @memberof MemberChangeFrom
     */
    number: number | null;
    /**
     * 
     * @type {boolean}
     * @memberof MemberChangeFrom
     */
    current: boolean;
}
/**
 * 
 * @export
 * @interface MemberChangeMovedInner
 */
export interface MemberChangeMovedInner {
    /**
     * 
     * @type {string}
     * @memberof MemberChangeMovedInner
     */
    figure: string;
    /**
     * dollars or milliseconds per run, moved by a tenth of where they stood; a share (0–1), moved by 0.1
     * @type {string}
     * @memberof MemberChangeMovedInner
     */
    unit: MemberChangeMovedInnerUnitEnum;
    /**
     * 
     * @type {number}
     * @memberof MemberChangeMovedInner
     */
    from: number;
    /**
     * 
     * @type {number}
     * @memberof MemberChangeMovedInner
     */
    to: number;
    /**
     * 
     * @type {string}
     * @memberof MemberChangeMovedInner
     */
    direction: MemberChangeMovedInnerDirectionEnum;
}


/**
 * @export
 */
export const MemberChangeMovedInnerUnitEnum = {
    Usd: 'usd',
    Ms: 'ms',
    Share: 'share'
} as const;
export type MemberChangeMovedInnerUnitEnum = typeof MemberChangeMovedInnerUnitEnum[keyof typeof MemberChangeMovedInnerUnitEnum];

/**
 * @export
 */
export const MemberChangeMovedInnerDirectionEnum = {
    Better: 'better',
    Worse: 'worse'
} as const;
export type MemberChangeMovedInnerDirectionEnum = typeof MemberChangeMovedInnerDirectionEnum[keyof typeof MemberChangeMovedInnerDirectionEnum];

/**
 * 
 * @export
 * @interface MemberChangeTeam
 */
export interface MemberChangeTeam {
    /**
     * 
     * @type {TeamVersionRunFigures}
     * @memberof MemberChangeTeam
     */
    before: TeamVersionRunFigures;
    /**
     * 
     * @type {TeamVersionRunFigures}
     * @memberof MemberChangeTeam
     */
    after: TeamVersionRunFigures;
}
/**
 * 
 * @export
 * @interface MemberHealth
 */
export interface MemberHealth {
    /**
     * 
     * @type {string}
     * @memberof MemberHealth
     */
    memberId: string;
    /**
     * Each CLI and profile the member runs on, so a reader can add its own sign-in reading
     * @type {Array<MemberSeat>}
     * @memberof MemberHealth
     */
    seats: Array<MemberSeat>;
    /**
     * error if any problem blocks a run, else checking while MCP is still being read, else warning if any problem informs, else ok
     * @type {string}
     * @memberof MemberHealth
     */
    status: MemberHealthStatusEnum;
    /**
     * A read of the member's MCP servers is still running, whatever its status
     * @type {boolean}
     * @memberof MemberHealth
     */
    checking: boolean;
    /**
     * 
     * @type {Array<HealthProblem>}
     * @memberof MemberHealth
     */
    problems: Array<HealthProblem>;
    /**
     * 
     * @type {string}
     * @memberof MemberHealth
     */
    mcpCheckedAt: string | null;
}


/**
 * @export
 */
export const MemberHealthStatusEnum = {
    Ok: 'ok',
    Warning: 'warning',
    Error: 'error',
    Checking: 'checking'
} as const;
export type MemberHealthStatusEnum = typeof MemberHealthStatusEnum[keyof typeof MemberHealthStatusEnum];

/**
 * 
 * @export
 * @interface MemberInstructionSize
 */
export interface MemberInstructionSize {
    /**
     * 
     * @type {string}
     * @memberof MemberInstructionSize
     */
    memberId: string;
    /**
     * The CLI measured — the member’s own, a pool’s first member
     * @type {AgentKind}
     * @memberof MemberInstructionSize
     */
    agent: AgentKind;
    /**
     * Which turn was measured: the member’s own turn, or — for a member only ever called — a turn answering a call
     * @type {string}
     * @memberof MemberInstructionSize
     */
    turn: MemberInstructionSizeTurnEnum;
    /**
     * Length of the composed block, exactly
     * @type {number}
     * @memberof MemberInstructionSize
     */
    totalChars: number;
    /**
     * 
     * @type {number}
     * @memberof MemberInstructionSize
     */
    approxTokens: number;
    /**
     * The paragraph breaks between parts — totalChars less the parts
     * @type {number}
     * @memberof MemberInstructionSize
     */
    separatorChars: number;
    /**
     * 
     * @type {Array<InstructionSizePart>}
     * @memberof MemberInstructionSize
     */
    parts: Array<InstructionSizePart>;
}


/**
 * @export
 */
export const MemberInstructionSizeTurnEnum = {
    Own: 'own',
    Call: 'call'
} as const;
export type MemberInstructionSizeTurnEnum = typeof MemberInstructionSizeTurnEnum[keyof typeof MemberInstructionSizeTurnEnum];

/**
 * 
 * @export
 * @interface MemberSeat
 */
export interface MemberSeat {
    /**
     * 
     * @type {AgentKind}
     * @memberof MemberSeat
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof MemberSeat
     */
    configDir: string | null;
    /**
     * 
     * @type {number}
     * @memberof MemberSeat
     */
    poolMember: number | null;
}


/**
 * 
 * @export
 * @interface MemberVersionFigures
 */
export interface MemberVersionFigures {
    /**
     * runs of the version it took part in
     * @type {number}
     * @memberof MemberVersionFigures
     */
    runs: number;
    /**
     * 
     * @type {number}
     * @memberof MemberVersionFigures
     */
    costPerRunUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof MemberVersionFigures
     */
    workedPerRunMs: number | null;
    /**
     * 
     * @type {number}
     * @memberof MemberVersionFigures
     */
    callFailureShare: number | null;
    /**
     * 
     * @type {number}
     * @memberof MemberVersionFigures
     */
    reworkShare: number | null;
    /**
     * 
     * @type {number}
     * @memberof MemberVersionFigures
     */
    cleanShare: number | null;
}
/**
 * 
 * @export
 * @interface MemberWork
 */
export interface MemberWork {
    /**
     * runs the metric ledgers watched from their start that the member took part in — what every figure here is counted over
     * @type {number}
     * @memberof MemberWork
     */
    measuredRuns: number;
    /**
     * calls other members made to it
     * @type {number}
     * @memberof MemberWork
     */
    callsAnswered: number;
    /**
     * of those, the calls that ended in an error
     * @type {number}
     * @memberof MemberWork
     */
    callsFailed: number;
    /**
     * 
     * @type {number}
     * @memberof MemberWork
     */
    avgAnswerMs: number | null;
    /**
     * calls it made to other members
     * @type {number}
     * @memberof MemberWork
     */
    callsMade: number;
    /**
     * 
     * @type {number}
     * @memberof MemberWork
     */
    toolCalls: number;
    /**
     * tool calls that ended in an error
     * @type {number}
     * @memberof MemberWork
     */
    toolErrors: number;
    /**
     * 
     * @type {MemberWorkGoals}
     * @memberof MemberWork
     */
    goals: MemberWorkGoals;
    /**
     * of the measured runs, those where none of its work failed or was redone: no call to it failed, no stage it owns was reopened, no goal it recorded ended not achieved
     * @type {number}
     * @memberof MemberWork
     */
    cleanRuns: number;
    /**
     * completions of stages it was responsible for in its run’s team version, whoever moved them
     * @type {number}
     * @memberof MemberWork
     */
    stagesCompleted: number;
    /**
     * of those, the completions a later move reopened in the same run — rework
     * @type {number}
     * @memberof MemberWork
     */
    completionsReopened: number;
}
/**
 * the goals it recorded
 * @export
 * @interface MemberWorkGoals
 */
export interface MemberWorkGoals {
    /**
     * goals it recorded, dropped ones included
     * @type {number}
     * @memberof MemberWorkGoals
     */
    recorded: number;
    /**
     * 
     * @type {number}
     * @memberof MemberWorkGoals
     */
    achieved: number;
    /**
     * 
     * @type {number}
     * @memberof MemberWorkGoals
     */
    notAchieved: number;
    /**
     * 
     * @type {number}
     * @memberof MemberWorkGoals
     */
    open: number;
    /**
     * 
     * @type {number}
     * @memberof MemberWorkGoals
     */
    dropped: number;
    /**
     * 
     * @type {number}
     * @memberof MemberWorkGoals
     */
    achievedShare: number | null;
}
/**
 * 
 * @export
 * @interface MemoryConfigAckDto
 */
export interface MemoryConfigAckDto {
    /**
     * 
     * @type {boolean}
     * @memberof MemoryConfigAckDto
     */
    enabled: boolean;
    /**
     * 
     * @type {string}
     * @memberof MemoryConfigAckDto
     */
    agentWrites: MemoryConfigAckDtoAgentWritesEnum;
    /**
     * 
     * @type {boolean}
     * @memberof MemoryConfigAckDto
     */
    nativeMemoryOff: boolean;
    /**
     * 
     * @type {number}
     * @memberof MemoryConfigAckDto
     */
    autoForgetAfterDays: number | null;
    /**
     * 
     * @type {boolean}
     * @memberof MemoryConfigAckDto
     */
    removeNotUseful: boolean;
}


/**
 * @export
 */
export const MemoryConfigAckDtoAgentWritesEnum = {
    Active: 'active',
    Pending: 'pending'
} as const;
export type MemoryConfigAckDtoAgentWritesEnum = typeof MemoryConfigAckDtoAgentWritesEnum[keyof typeof MemoryConfigAckDtoAgentWritesEnum];

/**
 * 
 * @export
 * @interface MemoryConfigDto
 */
export interface MemoryConfigDto {
    /**
     * 
     * @type {boolean}
     * @memberof MemoryConfigDto
     */
    enabled: boolean;
    /**
     * 
     * @type {string}
     * @memberof MemoryConfigDto
     */
    agentWrites: MemoryConfigDtoAgentWritesEnum;
    /**
     * 
     * @type {boolean}
     * @memberof MemoryConfigDto
     */
    nativeMemoryOff: boolean;
    /**
     * 
     * @type {number}
     * @memberof MemoryConfigDto
     */
    autoForgetAfterDays: number | null;
    /**
     * 
     * @type {boolean}
     * @memberof MemoryConfigDto
     */
    removeNotUseful: boolean;
}


/**
 * @export
 */
export const MemoryConfigDtoAgentWritesEnum = {
    Active: 'active',
    Pending: 'pending'
} as const;
export type MemoryConfigDtoAgentWritesEnum = typeof MemoryConfigDtoAgentWritesEnum[keyof typeof MemoryConfigDtoAgentWritesEnum];

/**
 * 
 * @export
 * @interface MemoryEntry
 */
export interface MemoryEntry {
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    handle: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    body: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    type: MemoryEntryTypeEnum;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    projectId: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    teamSlug: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    status: MemoryEntryStatusEnum;
    /**
     * 
     * @type {number}
     * @memberof MemoryEntry
     */
    rev: number;
    /**
     * 
     * @type {MemoryEntrySource}
     * @memberof MemoryEntry
     */
    source: MemoryEntrySource;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    updatedAt: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    lastUsedAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    approvedAt: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof MemoryEntry
     */
    indexed: boolean;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    promotedAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    forgetReason: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntry
     */
    purgeAt: string | null;
}


/**
 * @export
 */
export const MemoryEntryTypeEnum = {
    User: 'user',
    Feedback: 'feedback',
    Project: 'project',
    Reference: 'reference'
} as const;
export type MemoryEntryTypeEnum = typeof MemoryEntryTypeEnum[keyof typeof MemoryEntryTypeEnum];

/**
 * @export
 */
export const MemoryEntryStatusEnum = {
    Active: 'active',
    Pending: 'pending',
    Forgotten: 'forgotten'
} as const;
export type MemoryEntryStatusEnum = typeof MemoryEntryStatusEnum[keyof typeof MemoryEntryStatusEnum];

/**
 * 
 * @export
 * @interface MemoryEntrySource
 */
export interface MemoryEntrySource {
    /**
     * 
     * @type {string}
     * @memberof MemoryEntrySource
     */
    actor: MemoryEntrySourceActorEnum;
    /**
     * 
     * @type {AgentKind}
     * @memberof MemoryEntrySource
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntrySource
     */
    model: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntrySource
     */
    runId: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryEntrySource
     */
    importedFrom: string | null;
}


/**
 * @export
 */
export const MemoryEntrySourceActorEnum = {
    Agent: 'agent',
    User: 'user',
    Import: 'import',
    Analysis: 'analysis',
    Lesson: 'lesson'
} as const;
export type MemoryEntrySourceActorEnum = typeof MemoryEntrySourceActorEnum[keyof typeof MemoryEntrySourceActorEnum];

/**
 * 
 * @export
 * @interface MemoryExportDto
 */
export interface MemoryExportDto {
    /**
     * 
     * @type {string}
     * @memberof MemoryExportDto
     */
    markdown: string;
    /**
     * 
     * @type {number}
     * @memberof MemoryExportDto
     */
    count: number;
}
/**
 * 
 * @export
 * @interface MemoryFinding
 */
export interface MemoryFinding {
    /**
     * 
     * @type {string}
     * @memberof MemoryFinding
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryFinding
     */
    kind: MemoryFindingKindEnum;
    /**
     * 
     * @type {MemoryEntry}
     * @memberof MemoryFinding
     */
    a: MemoryEntry;
    /**
     * 
     * @type {MemoryEntry}
     * @memberof MemoryFinding
     */
    b: MemoryEntry;
    /**
     * 
     * @type {string}
     * @memberof MemoryFinding
     */
    quoteA: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryFinding
     */
    quoteB: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryFinding
     */
    reason: string;
    /**
     * 
     * @type {AgentKind}
     * @memberof MemoryFinding
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof MemoryFinding
     */
    model: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryFinding
     */
    checkedAt: string;
}


/**
 * @export
 */
export const MemoryFindingKindEnum = {
    Duplicate: 'duplicate',
    Supersedes: 'supersedes',
    Contradicts: 'contradicts',
    Conditional: 'conditional'
} as const;
export type MemoryFindingKindEnum = typeof MemoryFindingKindEnum[keyof typeof MemoryFindingKindEnum];

/**
 * 
 * @export
 * @interface MemoryFindingListDto
 */
export interface MemoryFindingListDto {
    /**
     * 
     * @type {Array<MemoryFinding>}
     * @memberof MemoryFindingListDto
     */
    findings: Array<MemoryFinding>;
}
/**
 * 
 * @export
 * @interface MemoryForgetBatch
 */
export interface MemoryForgetBatch {
    /**
     * 
     * @type {string}
     * @memberof MemoryForgetBatch
     */
    batchId: string;
    /**
     * 
     * @type {number}
     * @memberof MemoryForgetBatch
     */
    count: number;
    /**
     * 
     * @type {string}
     * @memberof MemoryForgetBatch
     */
    forgottenAt: string;
    /**
     * 
     * @type {boolean}
     * @memberof MemoryForgetBatch
     */
    automatic: boolean;
    /**
     * 
     * @type {string}
     * @memberof MemoryForgetBatch
     */
    kind: MemoryForgetBatchKindEnum;
    /**
     * 
     * @type {string}
     * @memberof MemoryForgetBatch
     */
    title: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryForgetBatch
     */
    reason: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryForgetBatch
     */
    purgeAt: string | null;
}


/**
 * @export
 */
export const MemoryForgetBatchKindEnum = {
    Manual: 'manual',
    Automatic: 'automatic',
    Marks: 'marks',
    ExpiredLesson: 'expired_lesson'
} as const;
export type MemoryForgetBatchKindEnum = typeof MemoryForgetBatchKindEnum[keyof typeof MemoryForgetBatchKindEnum];

/**
 * 
 * @export
 * @interface MemoryForgetBatchListDto
 */
export interface MemoryForgetBatchListDto {
    /**
     * 
     * @type {Array<MemoryForgetBatch>}
     * @memberof MemoryForgetBatchListDto
     */
    batches: Array<MemoryForgetBatch>;
}
/**
 * 
 * @export
 * @interface MemoryForgetBatchResultDto
 */
export interface MemoryForgetBatchResultDto {
    /**
     * 
     * @type {string}
     * @memberof MemoryForgetBatchResultDto
     */
    batchId: string | null;
    /**
     * 
     * @type {number}
     * @memberof MemoryForgetBatchResultDto
     */
    forgotten: number;
    /**
     * 
     * @type {Array<MemoryForgetBatchResultDtoSkippedInner>}
     * @memberof MemoryForgetBatchResultDto
     */
    skipped: Array<MemoryForgetBatchResultDtoSkippedInner>;
}
/**
 * 
 * @export
 * @interface MemoryForgetBatchResultDtoSkippedInner
 */
export interface MemoryForgetBatchResultDtoSkippedInner {
    /**
     * 
     * @type {string}
     * @memberof MemoryForgetBatchResultDtoSkippedInner
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryForgetBatchResultDtoSkippedInner
     */
    handle: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryForgetBatchResultDtoSkippedInner
     */
    reason: string;
}
/**
 * 
 * @export
 * @interface MemoryImportPreviewDto
 */
export interface MemoryImportPreviewDto {
    /**
     * 
     * @type {Array<MemoryImportRow>}
     * @memberof MemoryImportPreviewDto
     */
    rows: Array<MemoryImportRow>;
    /**
     * 
     * @type {Array<AgentKind>}
     * @memberof MemoryImportPreviewDto
     */
    triageAgents: Array<AgentKind>;
    /**
     * 
     * @type {Array<MemoryImportPreviewDtoSourcesInner>}
     * @memberof MemoryImportPreviewDto
     */
    sources: Array<MemoryImportPreviewDtoSourcesInner>;
}
/**
 * 
 * @export
 * @interface MemoryImportPreviewDtoSourcesInner
 */
export interface MemoryImportPreviewDtoSourcesInner {
    /**
     * 
     * @type {AgentKind}
     * @memberof MemoryImportPreviewDtoSourcesInner
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportPreviewDtoSourcesInner
     */
    path: string;
    /**
     * 
     * @type {number}
     * @memberof MemoryImportPreviewDtoSourcesInner
     */
    found: number;
}


/**
 * 
 * @export
 * @interface MemoryImportPreviewRequestDto
 */
export interface MemoryImportPreviewRequestDto {
    /**
     * 
     * @type {Array<MemoryImportPreviewRequestDtoProfilesInner>}
     * @memberof MemoryImportPreviewRequestDto
     */
    profiles: Array<MemoryImportPreviewRequestDtoProfilesInner>;
}
/**
 * 
 * @export
 * @interface MemoryImportPreviewRequestDtoProfilesInner
 */
export interface MemoryImportPreviewRequestDtoProfilesInner {
    /**
     * 
     * @type {AgentKind}
     * @memberof MemoryImportPreviewRequestDtoProfilesInner
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportPreviewRequestDtoProfilesInner
     */
    dir: string;
}


/**
 * 
 * @export
 * @interface MemoryImportResultDto
 */
export interface MemoryImportResultDto {
    /**
     * 
     * @type {number}
     * @memberof MemoryImportResultDto
     */
    imported: number;
    /**
     * 
     * @type {Array<MemoryImportResultDtoSkippedInner>}
     * @memberof MemoryImportResultDto
     */
    skipped: Array<MemoryImportResultDtoSkippedInner>;
}
/**
 * 
 * @export
 * @interface MemoryImportResultDtoSkippedInner
 */
export interface MemoryImportResultDtoSkippedInner {
    /**
     * 
     * @type {string}
     * @memberof MemoryImportResultDtoSkippedInner
     */
    key: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportResultDtoSkippedInner
     */
    reason: string;
}
/**
 * 
 * @export
 * @interface MemoryImportRow
 */
export interface MemoryImportRow {
    /**
     * 
     * @type {string}
     * @memberof MemoryImportRow
     */
    key: string;
    /**
     * 
     * @type {AgentKind}
     * @memberof MemoryImportRow
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportRow
     */
    sourcePath: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportRow
     */
    profile: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportRow
     */
    folder: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportRow
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportRow
     */
    body: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportRow
     */
    type: MemoryImportRowTypeEnum;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportRow
     */
    projectId: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportRow
     */
    projectMatch: MemoryImportRowProjectMatchEnum;
    /**
     * 
     * @type {Array<MemoryImportRowSimilarToInner>}
     * @memberof MemoryImportRow
     */
    similarTo: Array<MemoryImportRowSimilarToInner>;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportRow
     */
    sameAs: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof MemoryImportRow
     */
    alreadyImported: boolean;
    /**
     * 
     * @type {boolean}
     * @memberof MemoryImportRow
     */
    forgottenEarlier: boolean;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportRow
     */
    problem: string | null;
}


/**
 * @export
 */
export const MemoryImportRowTypeEnum = {
    User: 'user',
    Feedback: 'feedback',
    Project: 'project',
    Reference: 'reference'
} as const;
export type MemoryImportRowTypeEnum = typeof MemoryImportRowTypeEnum[keyof typeof MemoryImportRowTypeEnum];

/**
 * @export
 */
export const MemoryImportRowProjectMatchEnum = {
    Matched: 'matched',
    None: 'none',
    Ambiguous: 'ambiguous'
} as const;
export type MemoryImportRowProjectMatchEnum = typeof MemoryImportRowProjectMatchEnum[keyof typeof MemoryImportRowProjectMatchEnum];

/**
 * 
 * @export
 * @interface MemoryImportRowSimilarToInner
 */
export interface MemoryImportRowSimilarToInner {
    /**
     * 
     * @type {string}
     * @memberof MemoryImportRowSimilarToInner
     */
    handle: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportRowSimilarToInner
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportRowSimilarToInner
     */
    status: MemoryImportRowSimilarToInnerStatusEnum;
}


/**
 * @export
 */
export const MemoryImportRowSimilarToInnerStatusEnum = {
    Active: 'active',
    Pending: 'pending',
    Forgotten: 'forgotten'
} as const;
export type MemoryImportRowSimilarToInnerStatusEnum = typeof MemoryImportRowSimilarToInnerStatusEnum[keyof typeof MemoryImportRowSimilarToInnerStatusEnum];

/**
 * 
 * @export
 * @interface MemoryImportTriageDto
 */
export interface MemoryImportTriageDto {
    /**
     * 
     * @type {Array<MemoryImportTriageDtoVerdictsInner>}
     * @memberof MemoryImportTriageDto
     */
    verdicts: Array<MemoryImportTriageDtoVerdictsInner>;
}
/**
 * 
 * @export
 * @interface MemoryImportTriageDtoVerdictsInner
 */
export interface MemoryImportTriageDtoVerdictsInner {
    /**
     * 
     * @type {string}
     * @memberof MemoryImportTriageDtoVerdictsInner
     */
    key: string;
    /**
     * 
     * @type {boolean}
     * @memberof MemoryImportTriageDtoVerdictsInner
     */
    keep: boolean;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportTriageDtoVerdictsInner
     */
    reason: string;
}
/**
 * 
 * @export
 * @interface MemoryImportTriageRequestDto
 */
export interface MemoryImportTriageRequestDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof MemoryImportTriageRequestDto
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportTriageRequestDto
     */
    model?: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportTriageRequestDto
     */
    effort?: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportTriageRequestDto
     */
    contextWindow?: string;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof MemoryImportTriageRequestDto
     */
    modelParameters?: { [key: string]: string; };
    /**
     * 
     * @type {string}
     * @memberof MemoryImportTriageRequestDto
     */
    configDir?: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportTriageRequestDto
     */
    purpose?: MemoryImportTriageRequestDtoPurposeEnum;
    /**
     * 
     * @type {Array<MemoryImportTriageRequestDtoNotesInner>}
     * @memberof MemoryImportTriageRequestDto
     */
    notes: Array<MemoryImportTriageRequestDtoNotesInner>;
}


/**
 * @export
 */
export const MemoryImportTriageRequestDtoPurposeEnum = {
    Import: 'import',
    Cleanup: 'cleanup'
} as const;
export type MemoryImportTriageRequestDtoPurposeEnum = typeof MemoryImportTriageRequestDtoPurposeEnum[keyof typeof MemoryImportTriageRequestDtoPurposeEnum];

/**
 * 
 * @export
 * @interface MemoryImportTriageRequestDtoNotesInner
 */
export interface MemoryImportTriageRequestDtoNotesInner {
    /**
     * 
     * @type {string}
     * @memberof MemoryImportTriageRequestDtoNotesInner
     */
    key: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportTriageRequestDtoNotesInner
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportTriageRequestDtoNotesInner
     */
    body: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryImportTriageRequestDtoNotesInner
     */
    folder: string | null;
}
/**
 * 
 * @export
 * @interface MemoryIndexPreviewDto
 */
export interface MemoryIndexPreviewDto {
    /**
     * 
     * @type {number}
     * @memberof MemoryIndexPreviewDto
     */
    listed: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryIndexPreviewDto
     */
    eligible: number;
    /**
     * 
     * @type {Array<string>}
     * @memberof MemoryIndexPreviewDto
     */
    ids: Array<string>;
}
/**
 * 
 * @export
 * @interface MemoryKeepResultDto
 */
export interface MemoryKeepResultDto {
    /**
     * 
     * @type {string}
     * @memberof MemoryKeepResultDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryKeepResultDto
     */
    keptAt: string | null;
}
/**
 * 
 * @export
 * @interface MemoryListDto
 */
export interface MemoryListDto {
    /**
     * 
     * @type {Array<MemoryEntry>}
     * @memberof MemoryListDto
     */
    memories: Array<MemoryEntry>;
    /**
     * 
     * @type {Array<MemoryTrackRecord>}
     * @memberof MemoryListDto
     */
    tracks: Array<MemoryTrackRecord>;
    /**
     * 
     * @type {MemoryListDtoNext}
     * @memberof MemoryListDto
     */
    next: MemoryListDtoNext | null;
}
/**
 * 
 * @export
 * @interface MemoryListDtoNext
 */
export interface MemoryListDtoNext {
    /**
     * 
     * @type {string}
     * @memberof MemoryListDtoNext
     */
    beforeUpdatedAt: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryListDtoNext
     */
    beforeId: string;
}
/**
 * 
 * @export
 * @interface MemoryMergeResultDto
 */
export interface MemoryMergeResultDto {
    /**
     * 
     * @type {MemoryEntry}
     * @memberof MemoryMergeResultDto
     */
    entry: MemoryEntry;
    /**
     * 
     * @type {string}
     * @memberof MemoryMergeResultDto
     */
    batchId: string;
    /**
     * 
     * @type {Array<string>}
     * @memberof MemoryMergeResultDto
     */
    forgotten: Array<string>;
}
/**
 * 
 * @export
 * @interface MemoryPair
 */
export interface MemoryPair {
    /**
     * 
     * @type {string}
     * @memberof MemoryPair
     */
    aId: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryPair
     */
    bId: string;
}
/**
 * 
 * @export
 * @interface MemoryPurgeResultDto
 */
export interface MemoryPurgeResultDto {
    /**
     * 
     * @type {string}
     * @memberof MemoryPurgeResultDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryPurgeResultDto
     */
    handle: string;
}
/**
 * 
 * @export
 * @interface MemoryRestoreBatchResultDto
 */
export interface MemoryRestoreBatchResultDto {
    /**
     * 
     * @type {number}
     * @memberof MemoryRestoreBatchResultDto
     */
    restored: number;
}
/**
 * 
 * @export
 * @interface MemoryReviewCheckRequestDto
 */
export interface MemoryReviewCheckRequestDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof MemoryReviewCheckRequestDto
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof MemoryReviewCheckRequestDto
     */
    model?: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryReviewCheckRequestDto
     */
    effort?: string;
    /**
     * 
     * @type {string}
     * @memberof MemoryReviewCheckRequestDto
     */
    contextWindow?: string;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof MemoryReviewCheckRequestDto
     */
    modelParameters?: { [key: string]: string; };
    /**
     * 
     * @type {string}
     * @memberof MemoryReviewCheckRequestDto
     */
    configDir?: string;
    /**
     * 
     * @type {Array<MemoryPair>}
     * @memberof MemoryReviewCheckRequestDto
     */
    pairs: Array<MemoryPair>;
}


/**
 * 
 * @export
 * @interface MemoryReviewCheckResultDto
 */
export interface MemoryReviewCheckResultDto {
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewCheckResultDto
     */
    checked: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewCheckResultDto
     */
    skipped: number;
    /**
     * 
     * @type {Array<MemoryFinding>}
     * @memberof MemoryReviewCheckResultDto
     */
    findings: Array<MemoryFinding>;
}
/**
 * 
 * @export
 * @interface MemoryReviewIdsDto
 */
export interface MemoryReviewIdsDto {
    /**
     * 
     * @type {Array<string>}
     * @memberof MemoryReviewIdsDto
     */
    ids: Array<string>;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewIdsDto
     */
    warnedSkipped: number;
}
/**
 * 
 * @export
 * @interface MemoryReviewPageDto
 */
export interface MemoryReviewPageDto {
    /**
     * 
     * @type {Array<MemoryReviewRow>}
     * @memberof MemoryReviewPageDto
     */
    rows: Array<MemoryReviewRow>;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewPageDto
     */
    total: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewPageDto
     */
    younger: number | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryReviewPageDto
     */
    next: string | null;
}
/**
 * 
 * @export
 * @interface MemoryReviewPairsDto
 */
export interface MemoryReviewPairsDto {
    /**
     * 
     * @type {Array<MemoryPair>}
     * @memberof MemoryReviewPairsDto
     */
    pairs: Array<MemoryPair>;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewPairsDto
     */
    inputTokens: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewPairsDto
     */
    requests: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewPairsDto
     */
    costUsd: number | null;
    /**
     * 
     * @type {Array<AgentKind>}
     * @memberof MemoryReviewPairsDto
     */
    checkAgents: Array<AgentKind>;
}
/**
 * 
 * @export
 * @interface MemoryReviewRow
 */
export interface MemoryReviewRow {
    /**
     * 
     * @type {MemoryEntry}
     * @memberof MemoryReviewRow
     */
    entry: MemoryEntry;
    /**
     * 
     * @type {MemoryReviewRowUsage}
     * @memberof MemoryReviewRow
     */
    usage: MemoryReviewRowUsage;
    /**
     * 
     * @type {string}
     * @memberof MemoryReviewRow
     */
    warning: MemoryReviewRowWarningEnum | null;
    /**
     * 
     * @type {Array<string>}
     * @memberof MemoryReviewRow
     */
    referencesGone: Array<string>;
    /**
     * 
     * @type {string}
     * @memberof MemoryReviewRow
     */
    keptAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryReviewRow
     */
    forgottenAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof MemoryReviewRow
     */
    forgetBatchId: string | null;
}


/**
 * @export
 */
export const MemoryReviewRowWarningEnum = {
    Feedback: 'feedback',
    User: 'user',
    WrittenByYou: 'writtenByYou',
    StatesLimit: 'statesLimit',
    NotChecked: 'notChecked'
} as const;
export type MemoryReviewRowWarningEnum = typeof MemoryReviewRowWarningEnum[keyof typeof MemoryReviewRowWarningEnum];

/**
 * 
 * @export
 * @interface MemoryReviewRowUsage
 */
export interface MemoryReviewRowUsage {
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewRowUsage
     */
    readsLast90Days: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewRowUsage
     */
    reads: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewRowUsage
     */
    searchHits: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewRowUsage
     */
    indexShows: number;
    /**
     * 
     * @type {string}
     * @memberof MemoryReviewRowUsage
     */
    lastReadAt: string | null;
}
/**
 * 
 * @export
 * @interface MemoryReviewSummaryDto
 */
export interface MemoryReviewSummaryDto {
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewSummaryDto
     */
    active: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewSummaryDto
     */
    pending: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewSummaryDto
     */
    read: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewSummaryDto
     */
    neverRead: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewSummaryDto
     */
    proposed: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewSummaryDto
     */
    proposedWithWarning: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewSummaryDto
     */
    younger: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewSummaryDto
     */
    kept: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewSummaryDto
     */
    forgotten: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewSummaryDto
     */
    minAgeDays: number;
    /**
     * 
     * @type {string}
     * @memberof MemoryReviewSummaryDto
     */
    countedSince: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof MemoryReviewSummaryDto
     */
    counting: boolean;
    /**
     * 
     * @type {MemoryForgetBatch}
     * @memberof MemoryReviewSummaryDto
     */
    lastBatch: MemoryForgetBatch | null;
    /**
     * 
     * @type {Array<MemoryForgetBatch>}
     * @memberof MemoryReviewSummaryDto
     */
    lastPass: Array<MemoryForgetBatch>;
    /**
     * 
     * @type {MemoryReviewSummaryDtoAutoForget}
     * @memberof MemoryReviewSummaryDto
     */
    autoForget: MemoryReviewSummaryDtoAutoForget | null;
}
/**
 * 
 * @export
 * @interface MemoryReviewSummaryDtoAutoForget
 */
export interface MemoryReviewSummaryDtoAutoForget {
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewSummaryDtoAutoForget
     */
    days: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewSummaryDtoAutoForget
     */
    forget: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryReviewSummaryDtoAutoForget
     */
    warned: number;
}
/**
 * 
 * @export
 * @interface MemoryTrackRecord
 */
export interface MemoryTrackRecord {
    /**
     * 
     * @type {string}
     * @memberof MemoryTrackRecord
     */
    memoryId: string;
    /**
     * 
     * @type {number}
     * @memberof MemoryTrackRecord
     */
    indexShows: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryTrackRecord
     */
    reads: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryTrackRecord
     */
    helped: number;
    /**
     * 
     * @type {number}
     * @memberof MemoryTrackRecord
     */
    notUseful: number;
}
/**
 * 
 * @export
 * @interface MemoryTriageAgentsDto
 */
export interface MemoryTriageAgentsDto {
    /**
     * 
     * @type {Array<AgentKind>}
     * @memberof MemoryTriageAgentsDto
     */
    agents: Array<AgentKind>;
}
/**
 * 
 * @export
 * @interface MergeMemoriesDto
 */
export interface MergeMemoriesDto {
    /**
     * 
     * @type {string}
     * @memberof MergeMemoriesDto
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof MergeMemoriesDto
     */
    body: string;
    /**
     * 
     * @type {string}
     * @memberof MergeMemoriesDto
     */
    type: MergeMemoriesDtoTypeEnum;
    /**
     * 
     * @type {string}
     * @memberof MergeMemoriesDto
     */
    projectId: string | null;
    /**
     * 
     * @type {string}
     * @memberof MergeMemoriesDto
     */
    teamSlug?: string | null;
    /**
     * 
     * @type {Array<string>}
     * @memberof MergeMemoriesDto
     */
    sourceIds: Array<string>;
}


/**
 * @export
 */
export const MergeMemoriesDtoTypeEnum = {
    User: 'user',
    Feedback: 'feedback',
    Project: 'project',
    Reference: 'reference'
} as const;
export type MergeMemoriesDtoTypeEnum = typeof MergeMemoriesDtoTypeEnum[keyof typeof MergeMemoriesDtoTypeEnum];

/**
 * 
 * @export
 * @interface MoveTaskStatusDto
 */
export interface MoveTaskStatusDto {
    /**
     * 
     * @type {TaskStatus}
     * @memberof MoveTaskStatusDto
     */
    from: TaskStatus;
    /**
     * 
     * @type {TaskStatus}
     * @memberof MoveTaskStatusDto
     */
    to: TaskStatus;
}


/**
 * 
 * @export
 * @interface MoveTeamRunStageDto
 */
export interface MoveTeamRunStageDto {
    /**
     * 
     * @type {MoveTeamRunStageDtoStageMoveAction}
     * @memberof MoveTeamRunStageDto
     */
    action: MoveTeamRunStageDtoStageMoveAction;
    /**
     * The id of the stage to move
     * @type {string}
     * @memberof MoveTeamRunStageDto
     */
    stage: string;
    /**
     * At a fork: the id of the stage the run takes
     * @type {string}
     * @memberof MoveTeamRunStageDto
     */
    next?: string;
    /**
     * What was done, or why
     * @type {string}
     * @memberof MoveTeamRunStageDto
     */
    text: string;
    /**
     * The stage revision the user was looking at; a different one is refused 409 STAGE_PROGRESS_CHANGED
     * @type {number}
     * @memberof MoveTeamRunStageDto
     */
    expectedRev: number;
}



/**
 * 
 * @export
 */
export const MoveTeamRunStageDtoStageMoveAction = {
    Complete: 'complete',
    Skip: 'skip',
    Reopen: 'reopen'
} as const;
export type MoveTeamRunStageDtoStageMoveAction = typeof MoveTeamRunStageDtoStageMoveAction[keyof typeof MoveTeamRunStageDtoStageMoveAction];

/**
 * 
 * @export
 * @interface NamedPathsDto
 */
export interface NamedPathsDto {
    /**
     * Candidate folders, absolute
     * @type {Array<string>}
     * @memberof NamedPathsDto
     */
    paths: Array<string>;
}
/**
 * 
 * @export
 * @interface NamedPathsResultDto
 */
export interface NamedPathsResultDto {
    /**
     * The asked-for paths a tool call of this run names
     * @type {Array<string>}
     * @memberof NamedPathsResultDto
     */
    named: Array<string>;
}
/**
 * 
 * @export
 * @interface NodeStateDto
 */
export interface NodeStateDto {
    /**
     * 
     * @type {string}
     * @memberof NodeStateDto
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof NodeStateDto
     */
    memberId: string;
    /**
     * 
     * @type {NodeStatus}
     * @memberof NodeStateDto
     */
    status: NodeStatus;
    /**
     * 
     * @type {number}
     * @memberof NodeStateDto
     */
    contextTokens: number | null;
    /**
     * Whether contextTokens is geniro's stand-in for an occupancy the CLI did not state; false when the CLI stated it
     * @type {boolean}
     * @memberof NodeStateDto
     */
    contextEstimated: boolean;
    /**
     * 
     * @type {number}
     * @memberof NodeStateDto
     */
    contextWindowTokens: number | null;
    /**
     * 
     * @type {string}
     * @memberof NodeStateDto
     */
    model: string | null;
    /**
     * 
     * @type {Array<CallContextReading>}
     * @memberof NodeStateDto
     */
    calls: Array<CallContextReading>;
    /**
     * 
     * @type {Array<CallFigures>}
     * @memberof NodeStateDto
     */
    callFigures: Array<CallFigures>;
    /**
     * 
     * @type {ChatTotals}
     * @memberof NodeStateDto
     */
    totals: ChatTotals;
    /**
     * 
     * @type {ChatTotals}
     * @memberof NodeStateDto
     */
    mainTotals: ChatTotals;
    /**
     * 
     * @type {string}
     * @memberof NodeStateDto
     */
    promptCacheExpiresAt: string | null;
    /**
     * 
     * @type {number}
     * @memberof NodeStateDto
     */
    workedMs: number | null;
    /**
     * 
     * @type {number}
     * @memberof NodeStateDto
     */
    toolCalls: number | null;
    /**
     * 
     * @type {number}
     * @memberof NodeStateDto
     */
    startedAt: number | null;
    /**
     * 
     * @type {number}
     * @memberof NodeStateDto
     */
    endedAt: number | null;
    /**
     * 
     * @type {string}
     * @memberof NodeStateDto
     */
    error: string | null;
    /**
     * 
     * @type {number}
     * @memberof NodeStateDto
     */
    poolMember: number | null;
    /**
     * The user pinned that pool member, so the conversation never moves back on its own
     * @type {boolean}
     * @memberof NodeStateDto
     */
    poolMemberPinned: boolean;
    /**
     * 
     * @type {number}
     * @memberof NodeStateDto
     */
    poolMemberNext: number | null;
}



/**
 * 
 * @export
 */
export const NodeStatus = {
    Pending: 'pending',
    Running: 'running',
    Completed: 'completed',
    Failed: 'failed',
    Cancelled: 'cancelled',
    Skipped: 'skipped'
} as const;
export type NodeStatus = typeof NodeStatus[keyof typeof NodeStatus];

/**
 * 
 * @export
 * @interface OpenMonitor
 */
export interface OpenMonitor {
    /**
     * the id the agent knows it by, e.g. `m1`
     * @type {string}
     * @memberof OpenMonitor
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof OpenMonitor
     */
    description: string;
    /**
     * 
     * @type {string}
     * @memberof OpenMonitor
     */
    command: string;
    /**
     * 
     * @type {string}
     * @memberof OpenMonitor
     */
    memberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof OpenMonitor
     */
    callId: string | null;
    /**
     * 
     * @type {string}
     * @memberof OpenMonitor
     */
    startedAt: string;
    /**
     * when its timeout stops it, ISO-8601
     * @type {string}
     * @memberof OpenMonitor
     */
    endsAt: string;
}
/**
 * 
 * @export
 * @interface OpenShell
 */
export interface OpenShell {
    /**
     * the tool call that detached it — the id a kill is addressed to
     * @type {string}
     * @memberof OpenShell
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof OpenShell
     */
    command: string;
    /**
     * 
     * @type {string}
     * @memberof OpenShell
     */
    memberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof OpenShell
     */
    callId: string | null;
    /**
     * 
     * @type {number}
     * @memberof OpenShell
     */
    startedAt: number;
}
/**
 * 
 * @export
 * @interface PausedSpan
 */
export interface PausedSpan {
    /**
     * 
     * @type {number}
     * @memberof PausedSpan
     */
    startMs: number;
    /**
     * 
     * @type {number}
     * @memberof PausedSpan
     */
    endMs: number | null;
}
/**
 * 
 * @export
 * @interface PlanLimits
 */
export interface PlanLimits {
    /**
     * 
     * @type {string}
     * @memberof PlanLimits
     */
    plan: string | null;
    /**
     * 
     * @type {Array<PlanWindow>}
     * @memberof PlanLimits
     */
    windows: Array<PlanWindow>;
    /**
     * true when the CLI could not reach its plan's usage service and filled the figures in from its own last request — they can lag the account by a lot
     * @type {boolean}
     * @memberof PlanLimits
     */
    estimated: boolean;
}
/**
 * 
 * @export
 * @interface PlanWindow
 */
export interface PlanWindow {
    /**
     * the CLI's own key for the window — opaque, for keying rows
     * @type {string}
     * @memberof PlanWindow
     */
    key: string;
    /**
     * what to call it on screen
     * @type {string}
     * @memberof PlanWindow
     */
    label: string;
    /**
     * how much of the window is used, 0-100
     * @type {number}
     * @memberof PlanWindow
     */
    percent: number;
    /**
     * 
     * @type {string}
     * @memberof PlanWindow
     */
    resetsAt: string | null;
}
/**
 * 
 * @export
 * @interface PressActionDto
 */
export interface PressActionDto {
    /**
     * ID generated once per press and reused when the press is retried after RUN_BUSY
     * @type {string}
     * @memberof PressActionDto
     */
    clientMessageId: string;
}

/**
 * 
 * @export
 */
export const ProbeStatus = {
    Pass: 'pass',
    Fail: 'fail',
    Unknown: 'unknown'
} as const;
export type ProbeStatus = typeof ProbeStatus[keyof typeof ProbeStatus];

/**
 * 
 * @export
 * @interface ProcessFigures
 */
export interface ProcessFigures {
    /**
     * 
     * @type {number}
     * @memberof ProcessFigures
     */
    processes: number;
    /**
     * 
     * @type {number}
     * @memberof ProcessFigures
     */
    cpuPercent: number;
    /**
     * 
     * @type {number}
     * @memberof ProcessFigures
     */
    rssBytes: number;
}
/**
 * 
 * @export
 * @interface ProjectChatsDiscardedDto
 */
export interface ProjectChatsDiscardedDto {
    /**
     * 
     * @type {number}
     * @memberof ProjectChatsDiscardedDto
     */
    deleted: number;
}
/**
 * 
 * @export
 * @interface ProjectDeletedDto
 */
export interface ProjectDeletedDto {
    /**
     * True when the project row was removed
     * @type {boolean}
     * @memberof ProjectDeletedDto
     */
    deleted: boolean;
    /**
     * How many of its tasks were removed with it
     * @type {number}
     * @memberof ProjectDeletedDto
     */
    tasksRemoved: number;
    /**
     * How many of its knowledge documents moved to Global
     * @type {number}
     * @memberof ProjectDeletedDto
     */
    knowledgeMoved: number;
    /**
     * How many of its knowledge documents were deleted
     * @type {number}
     * @memberof ProjectDeletedDto
     */
    knowledgeDeleted: number;
    /**
     * Handles a move to Global changed, because Global held them
     * @type {Array<TeamRemovedDtoKnowledgeRenamedInner>}
     * @memberof ProjectDeletedDto
     */
    knowledgeRenamed: Array<TeamRemovedDtoKnowledgeRenamedInner>;
}
/**
 * 
 * @export
 * @interface ProjectDto
 */
export interface ProjectDto {
    /**
     * 
     * @type {string}
     * @memberof ProjectDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof ProjectDto
     */
    name: string;
    /**
     * The absolute project folder every task in it is worked in
     * @type {string}
     * @memberof ProjectDto
     */
    folder: string;
    /**
     * 
     * @type {string}
     * @memberof ProjectDto
     */
    groupId: string | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectDto
     */
    taskKey: string | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectDto
     */
    description: string | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectDto
     */
    instructions: string | null;
    /**
     * The instructions as the user wrote them, block by block
     * @type {Array<ProjectInstructionBlock>}
     * @memberof ProjectDto
     */
    instructionBlocks: Array<ProjectInstructionBlock>;
    /**
     * Counts every change to the description or instructions; quote it back as expectedInstructionsRevision so a stale write is refused instead of overwriting a newer one
     * @type {number}
     * @memberof ProjectDto
     */
    instructionsRevision: number;
    /**
     * 
     * @type {AgentKind}
     * @memberof ProjectDto
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectDto
     */
    model: string | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectDto
     */
    effort: string | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectDto
     */
    contextWindow: string | null;
    /**
     * Every other model setting a run here starts with, keyed by the CLI's own parameter id; {} when none are set
     * @type {{ [key: string]: string; }}
     * @memberof ProjectDto
     */
    modelParameters: { [key: string]: string; };
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof ProjectDto
     */
    approval: ChatApprovalMode | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectDto
     */
    configDir: string | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectDto
     */
    teamSlug: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof ProjectDto
     */
    autopilotEnabled: boolean;
    /**
     * The column the autopilot picks work up from
     * @type {TaskStatus}
     * @memberof ProjectDto
     */
    autopilotIntakeStatus: TaskStatus;
    /**
     * 
     * @type {number}
     * @memberof ProjectDto
     */
    autopilotMaxConcurrent: number;
    /**
     * Consecutive failed autopilot runs — the breaker reads it, and a success resets it to 0
     * @type {number}
     * @memberof ProjectDto
     */
    autopilotFailureStreak: number;
    /**
     * 
     * @type {string}
     * @memberof ProjectDto
     */
    autopilotLimitUntil: string | null;
    /**
     * Where this project's tasks come from — the value its tasks carry as their own source
     * @type {TaskSource}
     * @memberof ProjectDto
     */
    provider: TaskSource;
    /**
     * 
     * @type {LessonOverride}
     * @memberof ProjectDto
     */
    lessons: LessonOverride | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectDto
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof ProjectDto
     */
    updatedAt: string;
}


/**
 * 
 * @export
 * @interface ProjectForFolderDto
 */
export interface ProjectForFolderDto {
    /**
     * 
     * @type {ProjectForFolderDtoProject}
     * @memberof ProjectForFolderDto
     */
    project: ProjectForFolderDtoProject | null;
}
/**
 * 
 * @export
 * @interface ProjectForFolderDtoProject
 */
export interface ProjectForFolderDtoProject {
    /**
     * 
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    name: string;
    /**
     * The absolute project folder every task in it is worked in
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    folder: string;
    /**
     * 
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    groupId: string | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    taskKey: string | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    description: string | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    instructions: string | null;
    /**
     * The instructions as the user wrote them, block by block
     * @type {Array<ProjectInstructionBlock>}
     * @memberof ProjectForFolderDtoProject
     */
    instructionBlocks: Array<ProjectInstructionBlock>;
    /**
     * Counts every change to the description or instructions; quote it back as expectedInstructionsRevision so a stale write is refused instead of overwriting a newer one
     * @type {number}
     * @memberof ProjectForFolderDtoProject
     */
    instructionsRevision: number;
    /**
     * 
     * @type {AgentKind}
     * @memberof ProjectForFolderDtoProject
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    model: string | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    effort: string | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    contextWindow: string | null;
    /**
     * Every other model setting a run here starts with, keyed by the CLI's own parameter id; {} when none are set
     * @type {{ [key: string]: string; }}
     * @memberof ProjectForFolderDtoProject
     */
    modelParameters: { [key: string]: string; };
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof ProjectForFolderDtoProject
     */
    approval: ChatApprovalMode | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    configDir: string | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    teamSlug: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof ProjectForFolderDtoProject
     */
    autopilotEnabled: boolean;
    /**
     * The column the autopilot picks work up from
     * @type {TaskStatus}
     * @memberof ProjectForFolderDtoProject
     */
    autopilotIntakeStatus: TaskStatus;
    /**
     * 
     * @type {number}
     * @memberof ProjectForFolderDtoProject
     */
    autopilotMaxConcurrent: number;
    /**
     * Consecutive failed autopilot runs — the breaker reads it, and a success resets it to 0
     * @type {number}
     * @memberof ProjectForFolderDtoProject
     */
    autopilotFailureStreak: number;
    /**
     * 
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    autopilotLimitUntil: string | null;
    /**
     * Where this project's tasks come from — the value its tasks carry as their own source
     * @type {TaskSource}
     * @memberof ProjectForFolderDtoProject
     */
    provider: TaskSource;
    /**
     * 
     * @type {LessonOverride}
     * @memberof ProjectForFolderDtoProject
     */
    lessons: LessonOverride | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof ProjectForFolderDtoProject
     */
    updatedAt: string;
}


/**
 * 
 * @export
 * @interface ProjectInstructionBlock
 */
export interface ProjectInstructionBlock {
    /**
     * Unique block id within the project
     * @type {string}
     * @memberof ProjectInstructionBlock
     */
    id: string;
    /**
     * Short name shown in the editor
     * @type {string}
     * @memberof ProjectInstructionBlock
     */
    title: string;
    /**
     * Instruction text every run in the project receives
     * @type {string}
     * @memberof ProjectInstructionBlock
     */
    text: string;
}
/**
 * 
 * @export
 * @interface ProjectInstructionSizesDto
 */
export interface ProjectInstructionSizesDto {
    /**
     * 
     * @type {Array<AgentInstructionSize>}
     * @memberof ProjectInstructionSizesDto
     */
    agents: Array<AgentInstructionSize>;
    /**
     * Each instruction block’s own text; every run carries it, so `reaches` is 1
     * @type {Array<InstructionBlockSize>}
     * @memberof ProjectInstructionSizesDto
     */
    blocks: Array<InstructionBlockSize>;
}
/**
 * 
 * @export
 * @interface ProjectQueueDto
 */
export interface ProjectQueueDto {
    /**
     * 
     * @type {string}
     * @memberof ProjectQueueDto
     */
    projectId: string;
    /**
     * Whether this project is armed
     * @type {boolean}
     * @memberof ProjectQueueDto
     */
    enabled: boolean;
    /**
     * The column work is picked up from
     * @type {TaskStatus}
     * @memberof ProjectQueueDto
     */
    intakeStatus: TaskStatus;
    /**
     * How many tasks may run at once
     * @type {number}
     * @memberof ProjectQueueDto
     */
    cap: number;
    /**
     * How many of this project’s tasks hold a run that is still live
     * @type {number}
     * @memberof ProjectQueueDto
     */
    running: number;
    /**
     * How many tasks sit in the intake column in total
     * @type {number}
     * @memberof ProjectQueueDto
     */
    waiting: number;
    /**
     * True once consecutive failures reached the threshold
     * @type {boolean}
     * @memberof ProjectQueueDto
     */
    breakerOpen: boolean;
    /**
     * 
     * @type {number}
     * @memberof ProjectQueueDto
     */
    failureStreak: number;
    /**
     * The tasks that may be started now, oldest first
     * @type {Array<QueuedTask>}
     * @memberof ProjectQueueDto
     */
    eligible: Array<QueuedTask>;
    /**
     * Cards in the intake column that cannot start as they stand, with the reason — never handed out as eligible
     * @type {Array<BlockedTask>}
     * @memberof ProjectQueueDto
     */
    blocked: Array<BlockedTask>;
    /**
     * The cards whose agent is working right now, in no particular order — `running` is this list’s length
     * @type {Array<ActiveTask>}
     * @memberof ProjectQueueDto
     */
    active: Array<ActiveTask>;
}


/**
 * 
 * @export
 * @interface ProjectTeamOverlay
 */
export interface ProjectTeamOverlay {
    /**
     * 
     * @type {string}
     * @memberof ProjectTeamOverlay
     */
    projectId: string;
    /**
     * 
     * @type {string}
     * @memberof ProjectTeamOverlay
     */
    projectName: string;
    /**
     * True while the project's default team is this team — only then does a run apply the overlay
     * @type {boolean}
     * @memberof ProjectTeamOverlay
     */
    active: boolean;
    /**
     * 
     * @type {string}
     * @memberof ProjectTeamOverlay
     */
    defaultTeamSlug: string | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectTeamOverlay
     */
    defaultTeamName: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof ProjectTeamOverlay
     */
    hasOverlay: boolean;
    /**
     * 
     * @type {string}
     * @memberof ProjectTeamOverlay
     */
    hash: string | null;
    /**
     * Model-group fields and pools the overlay overrides
     * @type {number}
     * @memberof ProjectTeamOverlay
     */
    overrides: number;
    /**
     * Overlay instruction blocks
     * @type {number}
     * @memberof ProjectTeamOverlay
     */
    blocks: number;
    /**
     * Members with extra instructions
     * @type {number}
     * @memberof ProjectTeamOverlay
     */
    notes: number;
    /**
     * 
     * @type {Array<string>}
     * @memberof ProjectTeamOverlay
     */
    orphans: Array<string>;
    /**
     * 
     * @type {string}
     * @memberof ProjectTeamOverlay
     */
    unreadable: string | null;
    /**
     * 
     * @type {string}
     * @memberof ProjectTeamOverlay
     */
    slug: string;
    /**
     * 
     * @type {string}
     * @memberof ProjectTeamOverlay
     */
    teamName: string;
}
/**
 * 
 * @export
 * @interface ProjectTeamOverlaysDto
 */
export interface ProjectTeamOverlaysDto {
    /**
     * 
     * @type {Array<ProjectTeamOverlay>}
     * @memberof ProjectTeamOverlaysDto
     */
    overlays: Array<ProjectTeamOverlay>;
}

/**
 * 
 * @export
 */
export const PromptCacheTtlReason = {
    ExtraUsage: 'extra-usage'
} as const;
export type PromptCacheTtlReason = typeof PromptCacheTtlReason[keyof typeof PromptCacheTtlReason];

/**
 * 
 * @export
 * @interface PullRequestOutcome
 */
export interface PullRequestOutcome {
    /**
     * the `run_outcome` row it was read from
     * @type {number}
     * @memberof PullRequestOutcome
     */
    seq: number;
    /**
     * 
     * @type {boolean}
     * @memberof PullRequestOutcome
     */
    draft: boolean;
    /**
     * 
     * @type {number}
     * @memberof PullRequestOutcome
     */
    reviewRounds: number;
    /**
     * 
     * @type {RunOutcomeAcceptance}
     * @memberof PullRequestOutcome
     */
    acceptance: RunOutcomeAcceptance;
    /**
     * 
     * @type {number}
     * @memberof PullRequestOutcome
     */
    questionsAsked: number;
}


/**
 * 
 * @export
 * @interface QueuedTask
 */
export interface QueuedTask {
    /**
     * 
     * @type {string}
     * @memberof QueuedTask
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof QueuedTask
     */
    title: string;
    /**
     * 
     * @type {TaskStatus}
     * @memberof QueuedTask
     */
    status: TaskStatus;
    /**
     * 
     * @type {number}
     * @memberof QueuedTask
     */
    position: number;
    /**
     * The folder to cut this card's worktree from — the card's own if it names one, else the project's. RESOLVED here rather than sent as two fields, because the conductor is a timer in another process and the inheritance rule belongs to whoever owns the two rows
     * @type {string}
     * @memberof QueuedTask
     */
    folder: string;
}


/**
 * 
 * @export
 * @interface RecheckMcpServerDto
 */
export interface RecheckMcpServerDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof RecheckMcpServerDto
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof RecheckMcpServerDto
     */
    cwd: string;
    /**
     * 
     * @type {string}
     * @memberof RecheckMcpServerDto
     */
    configDir?: string;
    /**
     * 
     * @type {string}
     * @memberof RecheckMcpServerDto
     */
    server: string;
}


/**
 * 
 * @export
 * @interface ReconcileTasksDto
 */
export interface ReconcileTasksDto {
    /**
     * 
     * @type {string}
     * @memberof ReconcileTasksDto
     */
    projectId?: string;
}
/**
 * 
 * @export
 * @interface ReflectLessonsDto
 */
export interface ReflectLessonsDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof ReflectLessonsDto
     */
    agentKind?: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof ReflectLessonsDto
     */
    model?: string;
    /**
     * 
     * @type {string}
     * @memberof ReflectLessonsDto
     */
    effort?: string;
    /**
     * 
     * @type {string}
     * @memberof ReflectLessonsDto
     */
    configDir?: string;
}


/**
 * 
 * @export
 * @interface RejectLessonDto
 */
export interface RejectLessonDto {
    /**
     * 
     * @type {string}
     * @memberof RejectLessonDto
     */
    reason?: string;
}
/**
 * 
 * @export
 * @interface RenameRunDto
 */
export interface RenameRunDto {
    /**
     * 
     * @type {string}
     * @memberof RenameRunDto
     */
    title: string;
}
/**
 * 
 * @export
 * @interface ReorderPinnedDto
 */
export interface ReorderPinnedDto {
    /**
     * 
     * @type {string}
     * @memberof ReorderPinnedDto
     */
    groupId: string | null;
    /**
     * 
     * @type {Array<string>}
     * @memberof ReorderPinnedDto
     */
    ids: Array<string>;
}
/**
 * 
 * @export
 * @interface ReorderRunGroupsDto
 */
export interface ReorderRunGroupsDto {
    /**
     * 
     * @type {Array<string>}
     * @memberof ReorderRunGroupsDto
     */
    ids: Array<string>;
}
/**
 * 
 * @export
 * @interface ReorderTasksDto
 */
export interface ReorderTasksDto {
    /**
     * 
     * @type {TaskStatus}
     * @memberof ReorderTasksDto
     */
    status: TaskStatus;
    /**
     * 
     * @type {Array<string>}
     * @memberof ReorderTasksDto
     */
    ids: Array<string>;
}


/**
 * 
 * @export
 * @interface ReportPrepareFailureDto
 */
export interface ReportPrepareFailureDto {
    /**
     * git's own line for why the worktree could not be made, shown on the board as the reason the card is held
     * @type {string}
     * @memberof ReportPrepareFailureDto
     */
    reason: string;
}
/**
 * 
 * @export
 * @interface ReportPullRequestMergedDto
 */
export interface ReportPullRequestMergedDto {
    /**
     * The pull request, exactly as the awaiting-merge list gave it
     * @type {string}
     * @memberof ReportPullRequestMergedDto
     */
    url: string;
    /**
     * 
     * @type {string}
     * @memberof ReportPullRequestMergedDto
     */
    mergedAt: string | null;
}
/**
 * 
 * @export
 * @interface ResetWakesCancelledDto
 */
export interface ResetWakesCancelledDto {
    /**
     * The calls that will NOT be continued at the usage-limit reset now
     * @type {Array<string>}
     * @memberof ResetWakesCancelledDto
     */
    cancelledCallIds: Array<string>;
}
/**
 * 
 * @export
 * @interface ResourceAlert
 */
export interface ResourceAlert {
    /**
     * 
     * @type {string}
     * @memberof ResourceAlert
     */
    id: string;
    /**
     * 
     * @type {ResourceAlertKind}
     * @memberof ResourceAlert
     */
    kind: ResourceAlertKind;
    /**
     * 
     * @type {string}
     * @memberof ResourceAlert
     */
    raisedAt: string;
    /**
     * 
     * @type {string}
     * @memberof ResourceAlert
     */
    runId: string | null;
    /**
     * 
     * @type {string}
     * @memberof ResourceAlert
     */
    title: string | null;
    /**
     * 
     * @type {AgentKind}
     * @memberof ResourceAlert
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof ResourceAlert
     */
    memberId: string | null;
    /**
     * 
     * @type {ResourceAlertCommand}
     * @memberof ResourceAlert
     */
    command: ResourceAlertCommand | null;
    /**
     * 
     * @type {number}
     * @memberof ResourceAlert
     */
    threadRssBytes: number | null;
    /**
     * 
     * @type {number}
     * @memberof ResourceAlert
     */
    growthBytesPerMinute: number | null;
    /**
     * 
     * @type {number}
     * @memberof ResourceAlert
     */
    freeDiskBytes: number | null;
    /**
     * 
     * @type {number}
     * @memberof ResourceAlert
     */
    minFreeDiskBytes: number | null;
    /**
     * whether the command was one this thread may stop when the alert was raised
     * @type {boolean}
     * @memberof ResourceAlert
     */
    stoppable: boolean;
}


/**
 * 
 * @export
 * @interface ResourceAlertCommand
 */
export interface ResourceAlertCommand {
    /**
     * 
     * @type {number}
     * @memberof ResourceAlertCommand
     */
    pid: number;
    /**
     * 
     * @type {string}
     * @memberof ResourceAlertCommand
     */
    name: string;
    /**
     * its command line on one line, secrets and env values masked
     * @type {string}
     * @memberof ResourceAlertCommand
     */
    label: string;
    /**
     * 
     * @type {number}
     * @memberof ResourceAlertCommand
     */
    rssBytes: number;
}
/**
 * 
 * @export
 * @interface ResourceAlertConfigAckDto
 */
export interface ResourceAlertConfigAckDto {
    /**
     * 
     * @type {boolean}
     * @memberof ResourceAlertConfigAckDto
     */
    enabled: boolean;
    /**
     * 
     * @type {number}
     * @memberof ResourceAlertConfigAckDto
     */
    threadMemoryBytes: number;
    /**
     * 
     * @type {number}
     * @memberof ResourceAlertConfigAckDto
     */
    growthBytesPerMinute: number;
    /**
     * 
     * @type {number}
     * @memberof ResourceAlertConfigAckDto
     */
    minFreeDiskBytes: number;
}
/**
 * 
 * @export
 * @interface ResourceAlertConfigDto
 */
export interface ResourceAlertConfigDto {
    /**
     * 
     * @type {boolean}
     * @memberof ResourceAlertConfigDto
     */
    enabled: boolean;
    /**
     * 
     * @type {number}
     * @memberof ResourceAlertConfigDto
     */
    threadMemoryBytes: number;
    /**
     * 
     * @type {number}
     * @memberof ResourceAlertConfigDto
     */
    growthBytesPerMinute: number;
    /**
     * 
     * @type {number}
     * @memberof ResourceAlertConfigDto
     */
    minFreeDiskBytes: number;
}

/**
 * 
 * @export
 */
export const ResourceAlertKind = {
    ThreadMemory: 'thread-memory',
    ThreadGrowth: 'thread-growth',
    MemoryPressure: 'memory-pressure',
    LowDisk: 'low-disk'
} as const;
export type ResourceAlertKind = typeof ResourceAlertKind[keyof typeof ResourceAlertKind];

/**
 * 
 * @export
 * @interface ResourceAlertsDto
 */
export interface ResourceAlertsDto {
    /**
     * oldest first
     * @type {Array<ResourceAlert>}
     * @memberof ResourceAlertsDto
     */
    alerts: Array<ResourceAlert>;
}
/**
 * 
 * @export
 * @interface RestoreKnowledgeRevisionDto
 */
export interface RestoreKnowledgeRevisionDto {
    /**
     * 
     * @type {number}
     * @memberof RestoreKnowledgeRevisionDto
     */
    rev: number;
}
/**
 * 
 * @export
 * @interface RestoreTeamVersionDto
 */
export interface RestoreTeamVersionDto {
    /**
     * 
     * @type {string}
     * @memberof RestoreTeamVersionDto
     */
    slug: string;
    /**
     * 
     * @type {string}
     * @memberof RestoreTeamVersionDto
     */
    version: string;
    /**
     * 
     * @type {string}
     * @memberof RestoreTeamVersionDto
     */
    baseHash?: string;
}
/**
 * 
 * @export
 * @interface RetriedDto
 */
export interface RetriedDto {
    /**
     * True when the conversation was reopened without re-prompting
     * @type {boolean}
     * @memberof RetriedDto
     */
    retried: boolean;
}
/**
 * 
 * @export
 * @interface RevokeAllSharesDto
 */
export interface RevokeAllSharesDto {
    /**
     * 
     * @type {number}
     * @memberof RevokeAllSharesDto
     */
    revoked: number;
    /**
     * 
     * @type {number}
     * @memberof RevokeAllSharesDto
     */
    failed: number;
    /**
     * 
     * @type {string}
     * @memberof RevokeAllSharesDto
     */
    detail: string | null;
}
/**
 * 
 * @export
 * @interface RevokeShareDto
 */
export interface RevokeShareDto {
    /**
     * 
     * @type {string}
     * @memberof RevokeShareDto
     */
    status: RevokeShareDtoStatusEnum;
    /**
     * 
     * @type {string}
     * @memberof RevokeShareDto
     */
    detail?: string;
}


/**
 * @export
 */
export const RevokeShareDtoStatusEnum = {
    Revoked: 'revoked',
    RevokeFailed: 'revoke-failed'
} as const;
export type RevokeShareDtoStatusEnum = typeof RevokeShareDtoStatusEnum[keyof typeof RevokeShareDtoStatusEnum];

/**
 * 
 * @export
 * @interface RevokeSharesDto
 */
export interface RevokeSharesDto {
    /**
     * 
     * @type {Array<string>}
     * @memberof RevokeSharesDto
     */
    shareIds: Array<string>;
}
/**
 * 
 * @export
 * @interface RunArtifact
 */
export interface RunArtifact {
    /**
     * the agent's own name for the page, and its identity
     * @type {string}
     * @memberof RunArtifact
     */
    artifactId: string;
    /**
     * the revision this listing names
     * @type {number}
     * @memberof RunArtifact
     */
    version: number;
    /**
     * 
     * @type {string}
     * @memberof RunArtifact
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof RunArtifact
     */
    summary: string | null;
    /**
     * the per-artifact capability the serving route authenticates on — an `<iframe src>` cannot send a header, so it rides the URL
     * @type {string}
     * @memberof RunArtifact
     */
    key: string;
    /**
     * when this version was published, ISO-8601
     * @type {string}
     * @memberof RunArtifact
     */
    at: string;
    /**
     * the row that announced it
     * @type {number}
     * @memberof RunArtifact
     */
    seq: number;
}
/**
 * 
 * @export
 * @interface RunArtifactsDto
 */
export interface RunArtifactsDto {
    /**
     * 
     * @type {Array<RunArtifact>}
     * @memberof RunArtifactsDto
     */
    artifacts: Array<RunArtifact>;
}

/**
 * 
 * @export
 */
export const RunAwaiting = {
    Question: 'question',
    Approval: 'approval'
} as const;
export type RunAwaiting = typeof RunAwaiting[keyof typeof RunAwaiting];

/**
 * 
 * @export
 * @interface RunCallState
 */
export interface RunCallState {
    /**
     * 
     * @type {string}
     * @memberof RunCallState
     */
    callId: string;
    /**
     * 
     * @type {string}
     * @memberof RunCallState
     */
    callerMemberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunCallState
     */
    calleeMemberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunCallState
     */
    title: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunCallState
     */
    brief: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunCallState
     */
    mode: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunCallState
     */
    thread: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunCallState
     */
    callerConversationId: string | null;
    /**
     * 
     * @type {number}
     * @memberof RunCallState
     */
    startSeq: number;
    /**
     * 
     * @type {string}
     * @memberof RunCallState
     */
    startedAt: string;
    /**
     * 
     * @type {string}
     * @memberof RunCallState
     */
    endedAt: string | null;
    /**
     * 
     * @type {RunWorkStatus}
     * @memberof RunCallState
     */
    status: RunWorkStatus;
    /**
     * still waiting for room under the run’s active-turn cap: out, and no turn of its own has started
     * @type {boolean}
     * @memberof RunCallState
     */
    queued: boolean;
    /**
     * 
     * @type {number}
     * @memberof RunCallState
     */
    member: number | null;
}


/**
 * 
 * @export
 * @interface RunDelegateState
 */
export interface RunDelegateState {
    /**
     * the launching tool call — the block id
     * @type {string}
     * @memberof RunDelegateState
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof RunDelegateState
     */
    memberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDelegateState
     */
    callId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDelegateState
     */
    label: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDelegateState
     */
    kind: string | null;
    /**
     * 
     * @type {RunDelegateStatus}
     * @memberof RunDelegateState
     */
    status: RunDelegateStatus;
    /**
     * an untracked delegate whose hosting process is gone: its work is over, only its outcome is unknown
     * @type {boolean}
     * @memberof RunDelegateState
     */
    processEnded: boolean;
    /**
     * 
     * @type {number}
     * @memberof RunDelegateState
     */
    launchSeq: number;
    /**
     * 
     * @type {string}
     * @memberof RunDelegateState
     */
    startedAt: string;
    /**
     * the tool calls this delegate made (rows carrying its id as parentToolUseId), over every row of the run up to the read's throughSeq
     * @type {number}
     * @memberof RunDelegateState
     */
    toolCalls: number;
    /**
     * the delegate's own assistant text messages, over every row of the run up to the read's throughSeq
     * @type {number}
     * @memberof RunDelegateState
     */
    messages: number;
    /**
     * 
     * @type {number}
     * @memberof RunDelegateState
     */
    requests: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunDelegateState
     */
    inputTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunDelegateState
     */
    outputTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunDelegateState
     */
    cacheReadTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunDelegateState
     */
    cacheCreationTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunDelegateState
     */
    contextTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunDelegateState
     */
    costUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunDelegateState
     */
    estimatedCostUsd: number | null;
    /**
     * true when the token figures above sum every request (counted by the daemon); false when nothing was counted for this delegate
     * @type {boolean}
     * @memberof RunDelegateState
     */
    cumulative: boolean;
}



/**
 * 
 * @export
 */
export const RunDelegateStatus = {
    Running: 'running',
    Completed: 'completed',
    Failed: 'failed',
    Cancelled: 'cancelled',
    Untracked: 'untracked'
} as const;
export type RunDelegateStatus = typeof RunDelegateStatus[keyof typeof RunDelegateStatus];

/**
 * 
 * @export
 * @interface RunDto
 */
export interface RunDto {
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    id: string;
    /**
     * 
     * @type {RunStatus}
     * @memberof RunDto
     */
    status: RunStatus;
    /**
     * 
     * @type {RunAwaiting}
     * @memberof RunDto
     */
    awaiting: RunAwaiting | null;
    /**
     * Units of background work this run is being held for; 0 when the agent itself is working
     * @type {number}
     * @memberof RunDto
     */
    holdingFor: number;
    /**
     * Agents of this run waiting on their own calls; 0 when none is waiting
     * @type {number}
     * @memberof RunDto
     */
    awaitingCalls: number;
    /**
     * Trigger members of this team run inside a turn (calls excluded); 0 when a message would be taken now
     * @type {number}
     * @memberof RunDto
     */
    rootsWorking: number;
    /**
     * Detached commands this run still has running; 0 when none are out
     * @type {number}
     * @memberof RunDto
     */
    shellsOpen: number;
    /**
     * Background sub-agents this run still has out; 0 when none are out
     * @type {number}
     * @memberof RunDto
     */
    subagentsOut: number;
    /**
     * Monitors this run has running; 0 when none are
     * @type {number}
     * @memberof RunDto
     */
    monitorsOpen: number;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    title: string | null;
    /**
     * 
     * @type {AgentKind}
     * @memberof RunDto
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    teamId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    cwd: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    startSha: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof RunDto
     */
    startDirty: boolean | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    model: string | null;
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof RunDto
     */
    approval: ChatApprovalMode | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    effort: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    contextWindow: string | null;
    /**
     * 
     * @type {number}
     * @memberof RunDto
     */
    autoCompactPercent: number | null;
    /**
     * Every OTHER model setting this run's next turn asks for, keyed by the CLI's own parameter id; {} when none are set. Sent back verbatim — geniro holds no vocabulary for these
     * @type {{ [key: string]: string; }}
     * @memberof RunDto
     */
    modelParameters: { [key: string]: string; };
    /**
     * 
     * @type {number}
     * @memberof RunDto
     */
    contextTokens: number | null;
    /**
     * Whether contextTokens is geniro's stand-in for an occupancy the CLI did not state; false when the CLI stated it
     * @type {boolean}
     * @memberof RunDto
     */
    contextEstimated: boolean;
    /**
     * 
     * @type {number}
     * @memberof RunDto
     */
    contextWindowTokens: number | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    configDir: string | null;
    /**
     * 
     * @type {ConfigDirPin}
     * @memberof RunDto
     */
    configDirPin: ConfigDirPin | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    groupId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    taskId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    taskIdentifier: string | null;
    /**
     * 
     * @type {RunProjectRef}
     * @memberof RunDto
     */
    project: RunProjectRef | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    analysisSourceRunId: string | null;
    /**
     * 
     * @type {number}
     * @memberof RunDto
     */
    analysisSourceSeq: number | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    analysisTeamSlug: string | null;
    /**
     * 
     * @type {number}
     * @memberof RunDto
     */
    pinnedPosition: number | null;
    /**
     * 
     * @type {RunGroupColor}
     * @memberof RunDto
     */
    color: RunGroupColor | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    createdAt: string;
    /**
     * The run's last-activity time
     * @type {string}
     * @memberof RunDto
     */
    updatedAt: string;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    lastMessage: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    lastActivityAt: string | null;
    /**
     * Pull requests this run opened, as captured from the agent output, and those its CLI recorded it touching; oldest first
     * @type {Array<DisplayedPullRequest>}
     * @memberof RunDto
     */
    pullRequests: Array<DisplayedPullRequest>;
    /**
     * Calls a usage limit stopped that geniro continues when the window reopens
     * @type {Array<RunResetWake>}
     * @memberof RunDto
     */
    resetWakes: Array<RunResetWake>;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    archivedAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    attentionAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    seenAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    notes: string | null;
    /**
     * Each agent's own task list as it stands now, folded from the whole transcript
     * @type {Array<RunTaskGroup>}
     * @memberof RunDto
     */
    taskList: Array<RunTaskGroup>;
    /**
     * 
     * @type {StageProgress}
     * @memberof RunDto
     */
    stages: StageProgress | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    currentLead: string | null;
    /**
     * The run's goals as the goals tool and the user left them, open and closed
     * @type {Array<RunGoal>}
     * @memberof RunDto
     */
    goals: Array<RunGoal>;
    /**
     * 
     * @type {ThreadOutcome}
     * @memberof RunDto
     */
    outcome: ThreadOutcome | null;
    /**
     * 
     * @type {number}
     * @memberof RunDto
     */
    workedMs: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunDto
     */
    toolCalls: number | null;
    /**
     * 
     * @type {string}
     * @memberof RunDto
     */
    promptCacheExpiresAt: string | null;
    /**
     * 
     * @type {number}
     * @memberof RunDto
     */
    promptCacheTtlMs: number | null;
    /**
     * 
     * @type {PromptCacheTtlReason}
     * @memberof RunDto
     */
    promptCacheTtlReason: PromptCacheTtlReason | null;
}


/**
 * 
 * @export
 * @interface RunGoal
 */
export interface RunGoal {
    /**
     * The goal within its run: g1, g2, …
     * @type {string}
     * @memberof RunGoal
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof RunGoal
     */
    text: string;
    /**
     * Who the goal came from: the user, or the agent working the task
     * @type {GoalSource}
     * @memberof RunGoal
     */
    source: GoalSource;
    /**
     * 
     * @type {GoalStatus}
     * @memberof RunGoal
     */
    status: GoalStatus;
    /**
     * 
     * @type {string}
     * @memberof RunGoal
     */
    evidence: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunGoal
     */
    memberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunGoal
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof RunGoal
     */
    closedAt: string | null;
}


/**
 * 
 * @export
 * @interface RunGoalsDto
 */
export interface RunGoalsDto {
    /**
     * 
     * @type {Array<RunGoal>}
     * @memberof RunGoalsDto
     */
    goals: Array<RunGoal>;
}

/**
 * 
 * @export
 */
export const RunGroupColor = {
    Blue: 'blue',
    Purple: 'purple',
    Green: 'green',
    Orange: 'orange',
    Pink: 'pink',
    Indigo: 'indigo',
    Teal: 'teal',
    Red: 'red'
} as const;
export type RunGroupColor = typeof RunGroupColor[keyof typeof RunGroupColor];

/**
 * 
 * @export
 * @interface RunGroupDeletedDto
 */
export interface RunGroupDeletedDto {
    /**
     * True when the group row was removed
     * @type {boolean}
     * @memberof RunGroupDeletedDto
     */
    deleted: boolean;
    /**
     * How many runs moved out of the group — they are kept, never deleted with it
     * @type {number}
     * @memberof RunGroupDeletedDto
     */
    released: number;
}
/**
 * 
 * @export
 * @interface RunGroupDto
 */
export interface RunGroupDto {
    /**
     * 
     * @type {string}
     * @memberof RunGroupDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof RunGroupDto
     */
    name: string;
    /**
     * 
     * @type {RunGroupColor}
     * @memberof RunGroupDto
     */
    color: RunGroupColor;
    /**
     * Sidebar order, ascending and contiguous from 0
     * @type {number}
     * @memberof RunGroupDto
     */
    position: number;
    /**
     * 
     * @type {boolean}
     * @memberof RunGroupDto
     */
    collapsed: boolean;
    /**
     * 
     * @type {string}
     * @memberof RunGroupDto
     */
    autoCwd: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunGroupDto
     */
    autoTeamId: string | null;
}


/**
 * 
 * @export
 * @interface RunMonitor
 */
export interface RunMonitor {
    /**
     * the id the agent knows it by, e.g. `m1`
     * @type {string}
     * @memberof RunMonitor
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof RunMonitor
     */
    description: string;
    /**
     * 
     * @type {string}
     * @memberof RunMonitor
     */
    command: string;
    /**
     * 
     * @type {string}
     * @memberof RunMonitor
     */
    startedAt: string;
    /**
     * when its timeout stops it, ISO-8601
     * @type {string}
     * @memberof RunMonitor
     */
    endsAt: string;
    /**
     * 
     * @type {number}
     * @memberof RunMonitor
     */
    pid: number | null;
    /**
     * the shell first, then its group depth-first
     * @type {Array<RunProcess>}
     * @memberof RunMonitor
     */
    processes: Array<RunProcess>;
    /**
     * 
     * @type {number}
     * @memberof RunMonitor
     */
    cpuPercent: number;
    /**
     * 
     * @type {number}
     * @memberof RunMonitor
     */
    rssBytes: number;
}

/**
 * 
 * @export
 */
export const RunOutcomeAcceptance = {
    Accepted: 'accepted',
    ChangesRequested: 'changes_requested',
    NotYet: 'not_yet',
    NotNeeded: 'not_needed'
} as const;
export type RunOutcomeAcceptance = typeof RunOutcomeAcceptance[keyof typeof RunOutcomeAcceptance];

/**
 * 
 * @export
 * @interface RunOutcomeEntry
 */
export interface RunOutcomeEntry {
    /**
     * 
     * @type {number}
     * @memberof RunOutcomeEntry
     */
    seq: number;
    /**
     * when the row was written (ISO)
     * @type {string}
     * @memberof RunOutcomeEntry
     */
    at: string;
    /**
     * 
     * @type {boolean}
     * @memberof RunOutcomeEntry
     */
    draft: boolean;
    /**
     * 
     * @type {number}
     * @memberof RunOutcomeEntry
     */
    reviewRounds: number;
    /**
     * 
     * @type {RunOutcomeAcceptance}
     * @memberof RunOutcomeEntry
     */
    acceptance: RunOutcomeAcceptance;
    /**
     * questions put to the user on the run before this outcome
     * @type {number}
     * @memberof RunOutcomeEntry
     */
    questionsAsked: number;
    /**
     * 
     * @type {string}
     * @memberof RunOutcomeEntry
     */
    summary: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunOutcomeEntry
     */
    nodeId: string;
}


/**
 * 
 * @export
 * @interface RunOutcomesDto
 */
export interface RunOutcomesDto {
    /**
     * 
     * @type {Array<RunPullRequestOutcomes>}
     * @memberof RunOutcomesDto
     */
    pullRequests: Array<RunPullRequestOutcomes>;
}
/**
 * 
 * @export
 * @interface RunProcess
 */
export interface RunProcess {
    /**
     * 
     * @type {number}
     * @memberof RunProcess
     */
    pid: number;
    /**
     * 
     * @type {number}
     * @memberof RunProcess
     */
    ppid: number;
    /**
     * levels below the CLI — 0 is the CLI itself
     * @type {number}
     * @memberof RunProcess
     */
    depth: number;
    /**
     * 
     * @type {string}
     * @memberof RunProcess
     */
    link: RunProcessLinkEnum;
    /**
     * what the process IS: the executable's basename, or the script an interpreter runs (`claude`, not `node`)
     * @type {string}
     * @memberof RunProcess
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof RunProcess
     */
    args: string;
    /**
     * the OS's own decayed CPU figure for this process, as `ps` reports it — percent of ONE core, so it can exceed 100
     * @type {number}
     * @memberof RunProcess
     */
    cpuPercent: number;
    /**
     * resident memory
     * @type {number}
     * @memberof RunProcess
     */
    rssBytes: number;
    /**
     * 
     * @type {number}
     * @memberof RunProcess
     */
    elapsedSeconds: number | null;
}


/**
 * @export
 */
export const RunProcessLinkEnum = {
    Root: 'root',
    Child: 'child',
    Group: 'group'
} as const;
export type RunProcessLinkEnum = typeof RunProcessLinkEnum[keyof typeof RunProcessLinkEnum];

/**
 * 
 * @export
 * @interface RunProcessTree
 */
export interface RunProcessTree {
    /**
     * 
     * @type {string}
     * @memberof RunProcessTree
     */
    sessionKey: string;
    /**
     * 
     * @type {string}
     * @memberof RunProcessTree
     */
    memberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunProcessTree
     */
    conversationId: string | null;
    /**
     * 
     * @type {AgentKind}
     * @memberof RunProcessTree
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof RunProcessTree
     */
    cwd: string;
    /**
     * 
     * @type {number}
     * @memberof RunProcessTree
     */
    rootPid: number;
    /**
     * the CLI first, then its tree depth-first
     * @type {Array<RunProcess>}
     * @memberof RunProcessTree
     */
    processes: Array<RunProcess>;
    /**
     * 
     * @type {number}
     * @memberof RunProcessTree
     */
    cpuPercent: number;
    /**
     * 
     * @type {number}
     * @memberof RunProcessTree
     */
    rssBytes: number;
}


/**
 * 
 * @export
 * @interface RunProcessesDto
 */
export interface RunProcessesDto {
    /**
     * when the process table was read, ISO-8601
     * @type {string}
     * @memberof RunProcessesDto
     */
    sampledAt: string;
    /**
     * 
     * @type {Array<RunProcessTree>}
     * @memberof RunProcessesDto
     */
    trees: Array<RunProcessTree>;
    /**
     * what the run's agents left running with no CLI of theirs above it — a `nohup` dev server, a watcher, a browser — found by the run's tag; each top process is `root`, depth-first under it. The same set archiving or deleting the run stops
     * @type {Array<RunProcess>}
     * @memberof RunProcessesDto
     */
    detached: Array<RunProcess>;
    /**
     * the run's agents' `monitor` commands, each with its process group — never listed again under `detached`
     * @type {Array<RunMonitor>}
     * @memberof RunProcessesDto
     */
    monitors: Array<RunMonitor>;
    /**
     * every process listed, the trees, `detached` and `monitors` together
     * @type {number}
     * @memberof RunProcessesDto
     */
    processes: number;
    /**
     * 
     * @type {number}
     * @memberof RunProcessesDto
     */
    cpuPercent: number;
    /**
     * 
     * @type {number}
     * @memberof RunProcessesDto
     */
    rssBytes: number;
    /**
     * 
     * @type {string}
     * @memberof RunProcessesDto
     */
    unavailableReason: string | null;
}
/**
 * 
 * @export
 * @interface RunProjectRef
 */
export interface RunProjectRef {
    /**
     * 
     * @type {string}
     * @memberof RunProjectRef
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof RunProjectRef
     */
    name: string;
}
/**
 * 
 * @export
 * @interface RunPullRequest
 */
export interface RunPullRequest {
    /**
     * 
     * @type {string}
     * @memberof RunPullRequest
     */
    owner: string;
    /**
     * 
     * @type {string}
     * @memberof RunPullRequest
     */
    repo: string;
    /**
     * 
     * @type {number}
     * @memberof RunPullRequest
     */
    number: number;
    /**
     * 
     * @type {string}
     * @memberof RunPullRequest
     */
    url: string;
    /**
     * 
     * @type {number}
     * @memberof RunPullRequest
     */
    seq: number;
}
/**
 * 
 * @export
 * @interface RunPullRequestOutcomes
 */
export interface RunPullRequestOutcomes {
    /**
     * 
     * @type {string}
     * @memberof RunPullRequestOutcomes
     */
    owner: string;
    /**
     * 
     * @type {string}
     * @memberof RunPullRequestOutcomes
     */
    repo: string;
    /**
     * 
     * @type {number}
     * @memberof RunPullRequestOutcomes
     */
    number: number;
    /**
     * as the newest outcome names it
     * @type {string}
     * @memberof RunPullRequestOutcomes
     */
    url: string;
    /**
     * times it went to changes_requested
     * @type {number}
     * @memberof RunPullRequestOutcomes
     */
    changesRequestedRounds: number;
    /**
     * 
     * @type {number}
     * @memberof RunPullRequestOutcomes
     */
    msToAccepted: number | null;
    /**
     * newest first
     * @type {Array<RunOutcomeEntry>}
     * @memberof RunPullRequestOutcomes
     */
    outcomes: Array<RunOutcomeEntry>;
}
/**
 * 
 * @export
 * @interface RunResetWake
 */
export interface RunResetWake {
    /**
     * 
     * @type {number}
     * @memberof RunResetWake
     */
    instant: number;
    /**
     * 
     * @type {number}
     * @memberof RunResetWake
     */
    continuesAt: number;
    /**
     * 
     * @type {string}
     * @memberof RunResetWake
     */
    resetsAt: string;
    /**
     * 
     * @type {Array<string>}
     * @memberof RunResetWake
     */
    callIds: Array<string>;
}
/**
 * 
 * @export
 * @interface RunSeenDto
 */
export interface RunSeenDto {
    /**
     * 
     * @type {string}
     * @memberof RunSeenDto
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof RunSeenDto
     */
    attentionAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunSeenDto
     */
    seenAt: string;
}
/**
 * 
 * @export
 * @interface RunStateDto
 */
export interface RunStateDto {
    /**
     * the approval and question cards still waiting for an answer, oldest first
     * @type {Array<ChatHistoryDtoItemsInner>}
     * @memberof RunStateDto
     */
    openRequests: Array<ChatHistoryDtoItemsInner>;
    /**
     * every call, in start order
     * @type {Array<RunCallState>}
     * @memberof RunStateDto
     */
    calls: Array<RunCallState>;
    /**
     * every delegate, in launch order
     * @type {Array<RunDelegateState>}
     * @memberof RunStateDto
     */
    delegates: Array<RunDelegateState>;
    /**
     * each dynamic workflow's launching call and reply, and its first and newest announcement
     * @type {Array<ChatHistoryDtoItemsInner>}
     * @memberof RunStateDto
     */
    workflowRows: Array<ChatHistoryDtoItemsInner>;
    /**
     * every artifact-tool call and its reply
     * @type {Array<ChatHistoryDtoItemsInner>}
     * @memberof RunStateDto
     */
    artifactRows: Array<ChatHistoryDtoItemsInner>;
    /**
     * every DETACHED command still running
     * @type {Array<OpenShell>}
     * @memberof RunStateDto
     */
    shells: Array<OpenShell>;
    /**
     * every conversation's monitors still running, in start order
     * @type {Array<OpenMonitor>}
     * @memberof RunStateDto
     */
    monitors: Array<OpenMonitor>;
    /**
     * the buttons agents published that can still be pressed, newest first
     * @type {Array<LiveAction>}
     * @memberof RunStateDto
     */
    actions: Array<LiveAction>;
    /**
     * the unanswered tool calls of every conversation's open turn — the commands running in the foreground, whatever page a client holds
     * @type {Array<ChatHistoryDtoItemsInner>}
     * @memberof RunStateDto
     */
    openToolCalls: Array<ChatHistoryDtoItemsInner>;
    /**
     * the run's newest seq when this was read: what it says ended, ended — for anything that started at or before it
     * @type {number}
     * @memberof RunStateDto
     */
    throughSeq: number;
    /**
     * 
     * @type {string}
     * @memberof RunStateDto
     */
    turnStartedAt: string | null;
    /**
     * a 1:1 chat's open turn: how long the holds that have ended kept it waiting on background work it launched
     * @type {number}
     * @memberof RunStateDto
     */
    turnHeldMs: number;
    /**
     * 
     * @type {string}
     * @memberof RunStateDto
     */
    turnHeldSince: string | null;
}

/**
 * 
 * @export
 */
export const RunStatus = {
    Pending: 'pending',
    Running: 'running',
    Completed: 'completed',
    Failed: 'failed',
    Cancelled: 'cancelled'
} as const;
export type RunStatus = typeof RunStatus[keyof typeof RunStatus];

/**
 * 
 * @export
 * @interface RunTaskGroup
 */
export interface RunTaskGroup {
    /**
     * 
     * @type {string}
     * @memberof RunTaskGroup
     */
    memberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunTaskGroup
     */
    callId: string | null;
    /**
     * 
     * @type {Array<RunTaskRow>}
     * @memberof RunTaskGroup
     */
    tasks: Array<RunTaskRow>;
    /**
     * 
     * @type {boolean}
     * @memberof RunTaskGroup
     */
    snapshot: boolean;
}
/**
 * 
 * @export
 * @interface RunTaskRow
 */
export interface RunTaskRow {
    /**
     * 
     * @type {string}
     * @memberof RunTaskRow
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof RunTaskRow
     */
    title: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunTaskRow
     */
    status: RunTaskRowStatusEnum | null;
    /**
     * 
     * @type {string}
     * @memberof RunTaskRow
     */
    activeForm: string | null;
}


/**
 * @export
 */
export const RunTaskRowStatusEnum = {
    Pending: 'pending',
    InProgress: 'in_progress',
    Completed: 'completed'
} as const;
export type RunTaskRowStatusEnum = typeof RunTaskRowStatusEnum[keyof typeof RunTaskRowStatusEnum];

/**
 * 
 * @export
 * @interface RunTeamDto
 */
export interface RunTeamDto {
    /**
     * 
     * @type {string}
     * @memberof RunTeamDto
     */
    cwd: string;
    /**
     * 
     * @type {string}
     * @memberof RunTeamDto
     */
    prompt: string;
    /**
     * 
     * @type {Array<SendMessageDtoImagesInner>}
     * @memberof RunTeamDto
     */
    images?: Array<SendMessageDtoImagesInner>;
    /**
     * 
     * @type {string}
     * @memberof RunTeamDto
     */
    customInstructions?: string;
    /**
     * 
     * @type {string}
     * @memberof RunTeamDto
     */
    replyLanguage?: string;
    /**
     * 
     * @type {{ [key: string]: { [key: string]: boolean; }; }}
     * @memberof RunTeamDto
     */
    agentOptions?: { [key: string]: { [key: string]: boolean; }; };
    /**
     * 
     * @type {string}
     * @memberof RunTeamDto
     */
    startSha?: string;
    /**
     * 
     * @type {boolean}
     * @memberof RunTeamDto
     */
    startDirty?: boolean;
    /**
     * 
     * @type {string}
     * @memberof RunTeamDto
     */
    projectId?: string | null;
}
/**
 * 
 * @export
 * @interface RunTeamNotesDto
 */
export interface RunTeamNotesDto {
    /**
     * 
     * @type {Array<TeamNote>}
     * @memberof RunTeamNotesDto
     */
    notes: Array<TeamNote>;
}
/**
 * 
 * @export
 * @interface RunTeamSnapshotDto
 */
export interface RunTeamSnapshotDto {
    /**
     * 
     * @type {Team}
     * @memberof RunTeamSnapshotDto
     */
    team: Team;
}
/**
 * 
 * @export
 * @interface RunWaterfallCall
 */
export interface RunWaterfallCall {
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallCall
     */
    callId: string;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallCall
     */
    parentCallId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallCall
     */
    callerMemberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallCall
     */
    calleeMemberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallCall
     */
    mode: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallCall
     */
    status: string | null;
    /**
     * dispatched and not yet answered while the run is still working — drawn up to the run's last row
     * @type {boolean}
     * @memberof RunWaterfallCall
     */
    running: boolean;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallCall
     */
    startedAt: string;
    /**
     * the `call_started` row that opened the call
     * @type {number}
     * @memberof RunWaterfallCall
     */
    seq: number;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallCall
     */
    durationMs: number;
}
/**
 * 
 * @export
 * @interface RunWaterfallCriticalSegment
 */
export interface RunWaterfallCriticalSegment {
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallCriticalSegment
     */
    kind: RunWaterfallCriticalSegmentKindEnum;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallCriticalSegment
     */
    memberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallCriticalSegment
     */
    startedAt: string;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallCriticalSegment
     */
    durationMs: number;
}


/**
 * @export
 */
export const RunWaterfallCriticalSegmentKindEnum = {
    Work: 'work',
    WaitingOnUser: 'waiting_on_user',
    Idle: 'idle'
} as const;
export type RunWaterfallCriticalSegmentKindEnum = typeof RunWaterfallCriticalSegmentKindEnum[keyof typeof RunWaterfallCriticalSegmentKindEnum];

/**
 * 
 * @export
 * @interface RunWaterfallDelegate
 */
export interface RunWaterfallDelegate {
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallDelegate
     */
    memberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallDelegate
     */
    startedAt: string;
    /**
     * the `subagent_info` row that launched the sub-agent
     * @type {number}
     * @memberof RunWaterfallDelegate
     */
    seq: number;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallDelegate
     */
    durationMs: number;
}
/**
 * 
 * @export
 * @interface RunWaterfallDto
 */
export interface RunWaterfallDto {
    /**
     * first event of the run, ISO-8601
     * @type {string}
     * @memberof RunWaterfallDto
     */
    from: string;
    /**
     * last event of the run, ISO-8601
     * @type {string}
     * @memberof RunWaterfallDto
     */
    to: string;
    /**
     * 
     * @type {Array<RunWaterfallLane>}
     * @memberof RunWaterfallDto
     */
    lanes: Array<RunWaterfallLane>;
    /**
     * which tools each lane called, and how often; busiest first
     * @type {Array<RunWaterfallToolUse>}
     * @memberof RunWaterfallDto
     */
    toolUse: Array<RunWaterfallToolUse>;
    /**
     * 
     * @type {Array<RunWaterfallTurn>}
     * @memberof RunWaterfallDto
     */
    turns: Array<RunWaterfallTurn>;
    /**
     * 
     * @type {Array<RunWaterfallCall>}
     * @memberof RunWaterfallDto
     */
    calls: Array<RunWaterfallCall>;
    /**
     * 
     * @type {Array<RunWaterfallWait>}
     * @memberof RunWaterfallDto
     */
    waits: Array<RunWaterfallWait>;
    /**
     * 
     * @type {Array<RunWaterfallDelegate>}
     * @memberof RunWaterfallDto
     */
    delegates: Array<RunWaterfallDelegate>;
    /**
     * the stretches that set the wall clock, in order — folded over every span, before any list here is capped
     * @type {Array<RunWaterfallCriticalSegment>}
     * @memberof RunWaterfallDto
     */
    criticalPath: Array<RunWaterfallCriticalSegment>;
    /**
     * 
     * @type {ChatTotals}
     * @memberof RunWaterfallDto
     */
    totals: ChatTotals;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallDto
     */
    waitedOnUserMs: number | null;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallDto
     */
    partialReason: string | null;
}
/**
 * 
 * @export
 * @interface RunWaterfallLane
 */
export interface RunWaterfallLane {
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallLane
     */
    memberId: string | null;
    /**
     * 
     * @type {AgentKind}
     * @memberof RunWaterfallLane
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallLane
     */
    costUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallLane
     */
    estimatedCostUsd: number | null;
    /**
     * how many turns this lane TOOK — the larger of its `turn_complete` rows and the status rows recording a turn opening, never the spans the card can draw. Each of the three is short in a different case: a CLI reporting no timing draws no span, a cancelled turn writes no completion, and a chat writes no status row at all
     * @type {number}
     * @memberof RunWaterfallLane
     */
    turns: number;
    /**
     * the lane agent's OWN tool calls
     * @type {number}
     * @memberof RunWaterfallLane
     */
    toolCalls: number;
    /**
     * tool calls the lane agent's CLI sub-agents made (rows carrying `parentToolUseId`), filed under the agent that launched them
     * @type {number}
     * @memberof RunWaterfallLane
     */
    delegateToolCalls: number;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallLane
     */
    workedMs: number | null;
}


/**
 * 
 * @export
 * @interface RunWaterfallModelCost
 */
export interface RunWaterfallModelCost {
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallModelCost
     */
    model: string;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallModelCost
     */
    costUsd: number;
}
/**
 * 
 * @export
 * @interface RunWaterfallToolUse
 */
export interface RunWaterfallToolUse {
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallToolUse
     */
    memberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallToolUse
     */
    name: string;
    /**
     * the lane agent's OWN calls of this tool
     * @type {number}
     * @memberof RunWaterfallToolUse
     */
    calls: number;
    /**
     * its CLI sub-agents' calls of this tool
     * @type {number}
     * @memberof RunWaterfallToolUse
     */
    delegateCalls: number;
}
/**
 * 
 * @export
 * @interface RunWaterfallTurn
 */
export interface RunWaterfallTurn {
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallTurn
     */
    memberId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallTurn
     */
    callId: string | null;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallTurn
     */
    startedAt: string;
    /**
     * the transcript row a reader is taken to for this turn — its first row on the lane, or the row that closed it when it wrote none
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    seq: number;
    /**
     * 'cli' is the agent's own reported duration; 'derived' is measured from the rows this lane wrote, for a CLI that reports no timing
     * @type {string}
     * @memberof RunWaterfallTurn
     */
    timingSource: RunWaterfallTurnTimingSourceEnum;
    /**
     * how the turn ended — 'running' is one still in progress at the run's last row, drawn up to it
     * @type {string}
     * @memberof RunWaterfallTurn
     */
    outcome: RunWaterfallTurnOutcomeEnum;
    /**
     * the lane agent's OWN tool calls inside the turn's span — its CLI sub-agents' are `delegateToolCalls`
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    toolCalls: number;
    /**
     * tool calls the lane agent's CLI sub-agents made inside the turn's span (rows carrying `parentToolUseId`)
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    delegateToolCalls: number;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    durationMs: number;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    apiMs: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    ttftMs: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    timeToRequestMs: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    numTurns: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    costUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    estimatedCostUsd: number | null;
    /**
     * 
     * @type {Array<RunWaterfallModelCost>}
     * @memberof RunWaterfallTurn
     */
    modelCosts: Array<RunWaterfallModelCost> | null;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallTurn
     */
    model: string | null;
    /**
     * 
     * @type {RunWaterfallTurnMember}
     * @memberof RunWaterfallTurn
     */
    member: RunWaterfallTurnMember | null;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    inputTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    outputTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    cacheReadTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    contextTokens: number | null;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallTurn
     */
    contextWindowTokens: number | null;
}


/**
 * @export
 */
export const RunWaterfallTurnTimingSourceEnum = {
    Cli: 'cli',
    Derived: 'derived'
} as const;
export type RunWaterfallTurnTimingSourceEnum = typeof RunWaterfallTurnTimingSourceEnum[keyof typeof RunWaterfallTurnTimingSourceEnum];

/**
 * @export
 */
export const RunWaterfallTurnOutcomeEnum = {
    Completed: 'completed',
    Running: 'running',
    Failed: 'failed',
    Cancelled: 'cancelled'
} as const;
export type RunWaterfallTurnOutcomeEnum = typeof RunWaterfallTurnOutcomeEnum[keyof typeof RunWaterfallTurnOutcomeEnum];

/**
 * 
 * @export
 * @interface RunWaterfallTurnMember
 */
export interface RunWaterfallTurnMember {
    /**
     * 
     * @type {AgentKind}
     * @memberof RunWaterfallTurnMember
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallTurnMember
     */
    model: string | null;
}


/**
 * 
 * @export
 * @interface RunWaterfallWait
 */
export interface RunWaterfallWait {
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallWait
     */
    memberId: string | null;
    /**
     * a question put to the user, as against a permission the CLI asked for
     * @type {boolean}
     * @memberof RunWaterfallWait
     */
    question: boolean;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallWait
     */
    toolName: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof RunWaterfallWait
     */
    allowed: boolean | null;
    /**
     * 
     * @type {string}
     * @memberof RunWaterfallWait
     */
    startedAt: string;
    /**
     * the `approval_request` row that raised the card
     * @type {number}
     * @memberof RunWaterfallWait
     */
    seq: number;
    /**
     * 
     * @type {number}
     * @memberof RunWaterfallWait
     */
    durationMs: number;
}

/**
 * 
 * @export
 */
export const RunWorkStatus = {
    Running: 'running',
    Completed: 'completed',
    Failed: 'failed',
    Cancelled: 'cancelled'
} as const;
export type RunWorkStatus = typeof RunWorkStatus[keyof typeof RunWorkStatus];

/**
 * 
 * @export
 * @interface SaveArtifactAnswersDto
 */
export interface SaveArtifactAnswersDto {
    /**
     * 
     * @type {{ [key: string]: any; }}
     * @memberof SaveArtifactAnswersDto
     */
    changes: { [key: string]: any; };
}
/**
 * 
 * @export
 * @interface SaveLessonDto
 */
export interface SaveLessonDto {
    /**
     * 
     * @type {string}
     * @memberof SaveLessonDto
     */
    title?: string;
    /**
     * 
     * @type {string}
     * @memberof SaveLessonDto
     */
    rule?: string;
    /**
     * 
     * @type {LessonTarget}
     * @memberof SaveLessonDto
     */
    target?: LessonTarget;
}
/**
 * 
 * @export
 * @interface SaveTeamDto
 */
export interface SaveTeamDto {
    /**
     * 
     * @type {Team}
     * @memberof SaveTeamDto
     */
    team: Team;
    /**
     * The `hash` of the version this save was made from; a file changed since is refused 409 TEAM_CHANGED
     * @type {string}
     * @memberof SaveTeamDto
     */
    baseHash?: string;
}
/**
 * 
 * @export
 * @interface SaveTeamOverlayDto
 */
export interface SaveTeamOverlayDto {
    /**
     * 
     * @type {TeamOverlay}
     * @memberof SaveTeamOverlayDto
     */
    overlay: TeamOverlay;
    /**
     * 
     * @type {string}
     * @memberof SaveTeamOverlayDto
     */
    baseHash?: string | null;
}
/**
 * 
 * @export
 * @interface SendMessageDto
 */
export interface SendMessageDto {
    /**
     * 
     * @type {string}
     * @memberof SendMessageDto
     */
    text: string;
    /**
     * 
     * @type {Array<SendMessageDtoImagesInner>}
     * @memberof SendMessageDto
     */
    images?: Array<SendMessageDtoImagesInner>;
    /**
     * ID generated once per send and reused for retries
     * @type {string}
     * @memberof SendMessageDto
     */
    clientMessageId?: string;
    /**
     * What a press does about background sub-agents the message would cancel: ask refuses with FOLLOW_UP_CANCELS_SUBAGENTS, cancel sends anyway. Absent, the message is refused RUN_BUSY and stays queued
     * @type {SendMessageDtoFollowUpBackgroundWork}
     * @memberof SendMessageDto
     */
    backgroundWork?: SendMessageDtoFollowUpBackgroundWork;
    /**
     * Sent by the queue, not by a press: refused RUN_AWAITS_ANSWER while a card waits for the user, whom a new turn would cut off from it
     * @type {boolean}
     * @memberof SendMessageDto
     */
    waitForAnswer?: boolean;
}



/**
 * 
 * @export
 */
export const SendMessageDtoFollowUpBackgroundWork = {
    Ask: 'ask',
    Cancel: 'cancel'
} as const;
export type SendMessageDtoFollowUpBackgroundWork = typeof SendMessageDtoFollowUpBackgroundWork[keyof typeof SendMessageDtoFollowUpBackgroundWork];

/**
 * 
 * @export
 * @interface SendMessageDtoImagesInner
 */
export interface SendMessageDtoImagesInner {
    /**
     * 
     * @type {AttachmentMediaType}
     * @memberof SendMessageDtoImagesInner
     */
    mediaType: AttachmentMediaType;
    /**
     * base64-encoded image bytes
     * @type {string}
     * @memberof SendMessageDtoImagesInner
     */
    data: string;
}


/**
 * 
 * @export
 * @interface SetMcpServerEnabledDto
 */
export interface SetMcpServerEnabledDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof SetMcpServerEnabledDto
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof SetMcpServerEnabledDto
     */
    cwd: string;
    /**
     * 
     * @type {string}
     * @memberof SetMcpServerEnabledDto
     */
    configDir?: string;
    /**
     * 
     * @type {string}
     * @memberof SetMcpServerEnabledDto
     */
    server: string;
    /**
     * 
     * @type {boolean}
     * @memberof SetMcpServerEnabledDto
     */
    enabled: boolean;
}


/**
 * 
 * @export
 * @interface SetPoolMemberResultDto
 */
export interface SetPoolMemberResultDto {
    /**
     * 
     * @type {number}
     * @memberof SetPoolMemberResultDto
     */
    member: number;
    /**
     * `now`: moved (or pinned) at once; `next_turn`: a turn is running, so it moves when the next one starts; `unchanged`: already pinned there
     * @type {string}
     * @memberof SetPoolMemberResultDto
     */
    applied: SetPoolMemberResultDtoAppliedEnum;
}


/**
 * @export
 */
export const SetPoolMemberResultDtoAppliedEnum = {
    Now: 'now',
    NextTurn: 'next_turn',
    Unchanged: 'unchanged'
} as const;
export type SetPoolMemberResultDtoAppliedEnum = typeof SetPoolMemberResultDtoAppliedEnum[keyof typeof SetPoolMemberResultDtoAppliedEnum];

/**
 * 
 * @export
 * @interface SetRunColorDto
 */
export interface SetRunColorDto {
    /**
     * 
     * @type {RunGroupColor}
     * @memberof SetRunColorDto
     */
    color: RunGroupColor | null;
}


/**
 * 
 * @export
 * @interface SetRunGroupDto
 */
export interface SetRunGroupDto {
    /**
     * 
     * @type {string}
     * @memberof SetRunGroupDto
     */
    groupId: string | null;
}
/**
 * 
 * @export
 * @interface SetRunNotesDto
 */
export interface SetRunNotesDto {
    /**
     * 
     * @type {string}
     * @memberof SetRunNotesDto
     */
    notes: string;
}
/**
 * 
 * @export
 * @interface SetRunPinnedDto
 */
export interface SetRunPinnedDto {
    /**
     * 
     * @type {boolean}
     * @memberof SetRunPinnedDto
     */
    pinned: boolean;
}
/**
 * 
 * @export
 * @interface SetTeamRunPoolMemberDto
 */
export interface SetTeamRunPoolMemberDto {
    /**
     * The pool member (1-based) to run the member's own conversation on
     * @type {number}
     * @memberof SetTeamRunPoolMemberDto
     */
    member: number;
}
/**
 * 
 * @export
 * @interface Share
 */
export interface Share {
    /**
     * 
     * @type {string}
     * @memberof Share
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof Share
     */
    runId: string;
    /**
     * 
     * @type {string}
     * @memberof Share
     */
    artifactId: string;
    /**
     * 
     * @type {string}
     * @memberof Share
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof Share
     */
    destinationId: string;
    /**
     * 
     * @type {string}
     * @memberof Share
     */
    destinationName: string;
    /**
     * 
     * @type {number}
     * @memberof Share
     */
    sharedVersion: number;
    /**
     * 
     * @type {ShareActor}
     * @memberof Share
     */
    sharedBy: ShareActor;
    /**
     * 
     * @type {ShareStatus}
     * @memberof Share
     */
    status: ShareStatus;
    /**
     * 
     * @type {string}
     * @memberof Share
     */
    lastError: string | null;
    /**
     * 
     * @type {ShareSignInLabel}
     * @memberof Share
     */
    signIn: ShareSignInLabel | null;
    /**
     * 
     * @type {boolean}
     * @memberof Share
     */
    askedByAgent: boolean;
    /**
     * 
     * @type {string}
     * @memberof Share
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof Share
     */
    updatedAt: string;
}



/**
 * 
 * @export
 */
export const ShareActor = {
    User: 'user',
    Agent: 'agent'
} as const;
export type ShareActor = typeof ShareActor[keyof typeof ShareActor];

/**
 * 
 * @export
 * @interface ShareCheckResultDto
 */
export interface ShareCheckResultDto {
    /**
     * 
     * @type {ShareCheckState}
     * @memberof ShareCheckResultDto
     */
    state: ShareCheckState;
    /**
     * 
     * @type {string}
     * @memberof ShareCheckResultDto
     */
    detail?: string;
    /**
     * 
     * @type {ShareSignInLabel}
     * @memberof ShareCheckResultDto
     */
    signIn: ShareSignInLabel | null;
}



/**
 * 
 * @export
 */
export const ShareCheckState = {
    SignedIn: 'signed-in',
    SignInRequired: 'sign-in-required',
    CheckFailed: 'check-failed',
    NotSetUp: 'not-set-up'
} as const;
export type ShareCheckState = typeof ShareCheckState[keyof typeof ShareCheckState];

/**
 * 
 * @export
 * @interface ShareConfigAckDto
 */
export interface ShareConfigAckDto {
    /**
     * 
     * @type {string}
     * @memberof ShareConfigAckDto
     */
    receivedAt: string;
}
/**
 * 
 * @export
 * @interface ShareConfigDto
 */
export interface ShareConfigDto {
    /**
     * 
     * @type {Array<ShareConfigDtoShareDestination>}
     * @memberof ShareConfigDto
     */
    destinations: Array<ShareConfigDtoShareDestination>;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDto
     */
    defaultDestinationId: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof ShareConfigDto
     */
    agentsMayShare: boolean;
    /**
     * 
     * @type {number}
     * @memberof ShareConfigDto
     */
    autoRevokeAfterDays: number | null;
}
/**
 * @type ShareConfigDtoShareDestination
 * 
 * @export
 */
export type ShareConfigDtoShareDestination = ShareConfigDtoShareDestinationOneOf | ShareConfigDtoShareDestinationOneOf1 | ShareConfigDtoShareDestinationOneOf2;
/**
 * 
 * @export
 * @interface ShareConfigDtoShareDestinationOneOf
 */
export interface ShareConfigDtoShareDestinationOneOf {
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf
     */
    kind: ShareConfigDtoShareDestinationOneOfKindEnum;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf
     */
    linkBase: string;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf
     */
    bucket: string;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf
     */
    prefix?: string;
}


/**
 * @export
 */
export const ShareConfigDtoShareDestinationOneOfKindEnum = {
    Gcs: 'gcs'
} as const;
export type ShareConfigDtoShareDestinationOneOfKindEnum = typeof ShareConfigDtoShareDestinationOneOfKindEnum[keyof typeof ShareConfigDtoShareDestinationOneOfKindEnum];

/**
 * 
 * @export
 * @interface ShareConfigDtoShareDestinationOneOf1
 */
export interface ShareConfigDtoShareDestinationOneOf1 {
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf1
     */
    kind: ShareConfigDtoShareDestinationOneOf1KindEnum;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf1
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf1
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf1
     */
    linkBase: string;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf1
     */
    bucket: string;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf1
     */
    prefix?: string;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf1
     */
    profile?: string;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf1
     */
    region?: string;
}


/**
 * @export
 */
export const ShareConfigDtoShareDestinationOneOf1KindEnum = {
    S3: 's3'
} as const;
export type ShareConfigDtoShareDestinationOneOf1KindEnum = typeof ShareConfigDtoShareDestinationOneOf1KindEnum[keyof typeof ShareConfigDtoShareDestinationOneOf1KindEnum];

/**
 * 
 * @export
 * @interface ShareConfigDtoShareDestinationOneOf2
 */
export interface ShareConfigDtoShareDestinationOneOf2 {
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf2
     */
    kind: ShareConfigDtoShareDestinationOneOf2KindEnum;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf2
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf2
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof ShareConfigDtoShareDestinationOneOf2
     */
    linkBase: string;
    /**
     * 
     * @type {Array<string>}
     * @memberof ShareConfigDtoShareDestinationOneOf2
     */
    upload: Array<string>;
    /**
     * 
     * @type {Array<string>}
     * @memberof ShareConfigDtoShareDestinationOneOf2
     */
    remove: Array<string>;
    /**
     * 
     * @type {ShareConfigDtoShareDestinationOneOf2SignIn}
     * @memberof ShareConfigDtoShareDestinationOneOf2
     */
    signIn?: ShareConfigDtoShareDestinationOneOf2SignIn;
}


/**
 * @export
 */
export const ShareConfigDtoShareDestinationOneOf2KindEnum = {
    Command: 'command'
} as const;
export type ShareConfigDtoShareDestinationOneOf2KindEnum = typeof ShareConfigDtoShareDestinationOneOf2KindEnum[keyof typeof ShareConfigDtoShareDestinationOneOf2KindEnum];

/**
 * 
 * @export
 * @interface ShareConfigDtoShareDestinationOneOf2SignIn
 */
export interface ShareConfigDtoShareDestinationOneOf2SignIn {
    /**
     * 
     * @type {Array<string>}
     * @memberof ShareConfigDtoShareDestinationOneOf2SignIn
     */
    login?: Array<string>;
    /**
     * 
     * @type {Array<string>}
     * @memberof ShareConfigDtoShareDestinationOneOf2SignIn
     */
    patterns?: Array<string>;
}
/**
 * 
 * @export
 * @interface ShareCreatedDto
 */
export interface ShareCreatedDto {
    /**
     * 
     * @type {Share}
     * @memberof ShareCreatedDto
     */
    share: Share;
    /**
     * 
     * @type {string}
     * @memberof ShareCreatedDto
     */
    url: string | null;
}
/**
 * 
 * @export
 * @interface ShareLinkDto
 */
export interface ShareLinkDto {
    /**
     * 
     * @type {string}
     * @memberof ShareLinkDto
     */
    url: string;
}
/**
 * 
 * @export
 * @interface ShareListDto
 */
export interface ShareListDto {
    /**
     * 
     * @type {Array<Share>}
     * @memberof ShareListDto
     */
    shares: Array<Share>;
    /**
     * 
     * @type {string}
     * @memberof ShareListDto
     */
    configReceivedAt: string | null;
}
/**
 * 
 * @export
 * @interface ShareSignInLabel
 */
export interface ShareSignInLabel {
    /**
     * 
     * @type {string}
     * @memberof ShareSignInLabel
     */
    cli: string;
    /**
     * 
     * @type {string}
     * @memberof ShareSignInLabel
     */
    label: string;
}
/**
 * 
 * @export
 * @interface ShareSignInSessionDto
 */
export interface ShareSignInSessionDto {
    /**
     * 
     * @type {string}
     * @memberof ShareSignInSessionDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof ShareSignInSessionDto
     */
    destinationId: string;
    /**
     * 
     * @type {string}
     * @memberof ShareSignInSessionDto
     */
    label: string;
    /**
     * 
     * @type {string}
     * @memberof ShareSignInSessionDto
     */
    cli: string;
    /**
     * 
     * @type {ShareSignInStatus}
     * @memberof ShareSignInSessionDto
     */
    status: ShareSignInStatus;
    /**
     * 
     * @type {Array<string>}
     * @memberof ShareSignInSessionDto
     */
    lines: Array<string>;
    /**
     * 
     * @type {string}
     * @memberof ShareSignInSessionDto
     */
    url: string | null;
    /**
     * 
     * @type {string}
     * @memberof ShareSignInSessionDto
     */
    message: string | null;
    /**
     * 
     * @type {Array<string>}
     * @memberof ShareSignInSessionDto
     */
    retried: Array<string>;
}



/**
 * 
 * @export
 */
export const ShareSignInStatus = {
    Waiting: 'waiting',
    Verifying: 'verifying',
    Succeeded: 'succeeded',
    Failed: 'failed',
    Cancelled: 'cancelled',
    TimedOut: 'timed-out'
} as const;
export type ShareSignInStatus = typeof ShareSignInStatus[keyof typeof ShareSignInStatus];


/**
 * 
 * @export
 */
export const ShareStatus = {
    Live: 'live',
    RevokeFailed: 'revoke-failed',
    AwaitingSignIn: 'awaiting-sign-in',
    Failed: 'failed'
} as const;
export type ShareStatus = typeof ShareStatus[keyof typeof ShareStatus];

/**
 * 
 * @export
 * @interface ShellKillDto
 */
export interface ShellKillDto {
    /**
     * 
     * @type {boolean}
     * @memberof ShellKillDto
     */
    killed: boolean;
    /**
     * 
     * @type {string}
     * @memberof ShellKillDto
     */
    reason: string | null;
}
/**
 * 
 * @export
 * @interface ShellOutputDto
 */
export interface ShellOutputDto {
    /**
     * the tail of the output file, decoded as UTF-8
     * @type {string}
     * @memberof ShellOutputDto
     */
    text: string;
    /**
     * earlier output was dropped — this is the tail of a longer file
     * @type {boolean}
     * @memberof ShellOutputDto
     */
    truncated: boolean;
    /**
     * 
     * @type {string}
     * @memberof ShellOutputDto
     */
    unavailableReason: string | null;
}
/**
 * @type StageActor
 * 
 * @export
 */
export type StageActor = StageActorOneOf | StageActorOneOf1 | StageActorOneOf2;
/**
 * 
 * @export
 * @interface StageActorOneOf
 */
export interface StageActorOneOf {
    /**
     * 
     * @type {string}
     * @memberof StageActorOneOf
     */
    kind: StageActorOneOfKindEnum;
    /**
     * 
     * @type {string}
     * @memberof StageActorOneOf
     */
    nodeId: string;
    /**
     * 
     * @type {string}
     * @memberof StageActorOneOf
     */
    callId?: string;
}


/**
 * @export
 */
export const StageActorOneOfKindEnum = {
    Agent: 'agent'
} as const;
export type StageActorOneOfKindEnum = typeof StageActorOneOfKindEnum[keyof typeof StageActorOneOfKindEnum];

/**
 * 
 * @export
 * @interface StageActorOneOf1
 */
export interface StageActorOneOf1 {
    /**
     * 
     * @type {string}
     * @memberof StageActorOneOf1
     */
    kind: StageActorOneOf1KindEnum;
    /**
     * 
     * @type {string}
     * @memberof StageActorOneOf1
     */
    via: StageActorOneOf1ViaEnum;
}


/**
 * @export
 */
export const StageActorOneOf1KindEnum = {
    User: 'user'
} as const;
export type StageActorOneOf1KindEnum = typeof StageActorOneOf1KindEnum[keyof typeof StageActorOneOf1KindEnum];

/**
 * @export
 */
export const StageActorOneOf1ViaEnum = {
    Desktop: 'desktop',
    Remote: 'remote'
} as const;
export type StageActorOneOf1ViaEnum = typeof StageActorOneOf1ViaEnum[keyof typeof StageActorOneOf1ViaEnum];

/**
 * 
 * @export
 * @interface StageActorOneOf2
 */
export interface StageActorOneOf2 {
    /**
     * 
     * @type {string}
     * @memberof StageActorOneOf2
     */
    kind: StageActorOneOf2KindEnum;
}


/**
 * @export
 */
export const StageActorOneOf2KindEnum = {
    System: 'system'
} as const;
export type StageActorOneOf2KindEnum = typeof StageActorOneOf2KindEnum[keyof typeof StageActorOneOf2KindEnum];

/**
 * 
 * @export
 * @interface StageFigures
 */
export interface StageFigures {
    /**
     * 
     * @type {string}
     * @memberof StageFigures
     */
    stageId: string;
    /**
     * 
     * @type {number}
     * @memberof StageFigures
     */
    completed: number;
    /**
     * 
     * @type {number}
     * @memberof StageFigures
     */
    skipped: number;
    /**
     * 
     * @type {number}
     * @memberof StageFigures
     */
    reopened: number;
    /**
     * 
     * @type {number}
     * @memberof StageFigures
     */
    avgMs: number | null;
}
/**
 * 
 * @export
 * @interface StageMoveResultDto
 */
export interface StageMoveResultDto {
    /**
     * 
     * @type {StageProgress}
     * @memberof StageMoveResultDto
     */
    progress: StageProgress;
    /**
     * Whether the run's lead agent was woken, or will be when its turn ends
     * @type {boolean}
     * @memberof StageMoveResultDto
     */
    woke: boolean;
    /**
     * Whether the run has a lead agent to tell at all — false when its trigger starts no agent
     * @type {boolean}
     * @memberof StageMoveResultDto
     */
    hasLead: boolean;
}
/**
 * 
 * @export
 * @interface StageProgress
 */
export interface StageProgress {
    /**
     * how many moves the run has made
     * @type {number}
     * @memberof StageProgress
     */
    rev: number;
    /**
     * 
     * @type {string}
     * @memberof StageProgress
     */
    current: string | null;
    /**
     * 
     * @type {StageProgressPosition}
     * @memberof StageProgress
     */
    position: StageProgressPosition;
    /**
     * 
     * @type {Array<StageProgressEntry>}
     * @memberof StageProgress
     */
    stages: Array<StageProgressEntry>;
}
/**
 * 
 * @export
 * @interface StageProgressEntry
 */
export interface StageProgressEntry {
    /**
     * 
     * @type {string}
     * @memberof StageProgressEntry
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof StageProgressEntry
     */
    title: string;
    /**
     * 
     * @type {StageStatus}
     * @memberof StageProgressEntry
     */
    status: StageStatus;
    /**
     * the stages that may follow; two or more = one of them
     * @type {Array<string>}
     * @memberof StageProgressEntry
     */
    next: Array<string>;
    /**
     * the branch the run took after this stage, at a fork
     * @type {string}
     * @memberof StageProgressEntry
     */
    chosen?: string;
    /**
     * who finished or skipped it
     * @type {StageActor}
     * @memberof StageProgressEntry
     */
    by?: StageActor;
    /**
     * their summary or reason
     * @type {string}
     * @memberof StageProgressEntry
     */
    text?: string;
    /**
     * when it was finished or skipped
     * @type {string}
     * @memberof StageProgressEntry
     */
    at?: string;
    /**
     * the move that last set its status — the one that finished, skipped or reopened it, or the reopen that reset it (a stage_change row's rev); absent while no move has
     * @type {number}
     * @memberof StageProgressEntry
     */
    rev?: number;
}


/**
 * 
 * @export
 * @interface StageProgressPosition
 */
export interface StageProgressPosition {
    /**
     * 
     * @type {number}
     * @memberof StageProgressPosition
     */
    index: number;
    /**
     * 
     * @type {number}
     * @memberof StageProgressPosition
     */
    total: number;
}

/**
 * 
 * @export
 */
export const StageStatus = {
    Pending: 'pending',
    Current: 'current',
    Done: 'done',
    Skipped: 'skipped',
    NotTaken: 'not_taken'
} as const;
export type StageStatus = typeof StageStatus[keyof typeof StageStatus];

/**
 * 
 * @export
 * @interface StartProjectChatDto
 */
export interface StartProjectChatDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof StartProjectChatDto
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof StartProjectChatDto
     */
    model?: string;
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof StartProjectChatDto
     */
    approval?: ChatApprovalMode;
    /**
     * 
     * @type {string}
     * @memberof StartProjectChatDto
     */
    effort?: string;
    /**
     * 
     * @type {string}
     * @memberof StartProjectChatDto
     */
    contextWindow?: string;
    /**
     * 
     * @type {number}
     * @memberof StartProjectChatDto
     */
    autoCompactPercent?: number;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof StartProjectChatDto
     */
    modelParameters?: { [key: string]: string; };
    /**
     * 
     * @type {string}
     * @memberof StartProjectChatDto
     */
    configDir?: string;
    /**
     * 
     * @type {string}
     * @memberof StartProjectChatDto
     */
    customInstructions?: string;
    /**
     * 
     * @type {string}
     * @memberof StartProjectChatDto
     */
    replyLanguage?: string;
    /**
     * 
     * @type {{ [key: string]: { [key: string]: boolean; }; }}
     * @memberof StartProjectChatDto
     */
    agentOptions?: { [key: string]: { [key: string]: boolean; }; };
}


/**
 * 
 * @export
 * @interface StartShareSignInDto
 */
export interface StartShareSignInDto {
    /**
     * 
     * @type {string}
     * @memberof StartShareSignInDto
     */
    destinationId: string;
}
/**
 * 
 * @export
 * @interface StartTaskRunDto
 */
export interface StartTaskRunDto {
    /**
     * The worktree the agent works in — already created by the caller, and validated here only as a real directory
     * @type {string}
     * @memberof StartTaskRunDto
     */
    cwd: string;
    /**
     * The branch that worktree has checked out
     * @type {string}
     * @memberof StartTaskRunDto
     */
    branch: string;
    /**
     * 
     * @type {TaskStatus}
     * @memberof StartTaskRunDto
     */
    from: TaskStatus;
    /**
     * 
     * @type {string}
     * @memberof StartTaskRunDto
     */
    startSha?: string;
    /**
     * 
     * @type {boolean}
     * @memberof StartTaskRunDto
     */
    startDirty?: boolean;
    /**
     * Extra instructions for this one press, on top of the card
     * @type {string}
     * @memberof StartTaskRunDto
     */
    prompt?: string;
    /**
     * 
     * @type {AgentKind}
     * @memberof StartTaskRunDto
     */
    agentKind?: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof StartTaskRunDto
     */
    model?: string;
    /**
     * 
     * @type {string}
     * @memberof StartTaskRunDto
     */
    effort?: string;
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof StartTaskRunDto
     */
    approval?: ChatApprovalMode;
    /**
     * 
     * @type {string}
     * @memberof StartTaskRunDto
     */
    configDir?: string;
    /**
     * Run this press through a team instead of a single agent; outranks every agent field above
     * @type {string}
     * @memberof StartTaskRunDto
     */
    teamSlug?: string;
    /**
     * 
     * @type {string}
     * @memberof StartTaskRunDto
     */
    customInstructions?: string;
    /**
     * 
     * @type {string}
     * @memberof StartTaskRunDto
     */
    replyLanguage?: string;
    /**
     * 
     * @type {{ [key: string]: { [key: string]: boolean; }; }}
     * @memberof StartTaskRunDto
     */
    agentOptions?: { [key: string]: { [key: string]: boolean; }; };
    /**
     * Who pressed Run — `user` (default) or the `autopilot` timer, which is held to the project cap, the failure breaker and a forced approval mode
     * @type {string}
     * @memberof StartTaskRunDto
     */
    startedBy?: StartTaskRunDtoStartedByEnum;
}


/**
 * @export
 */
export const StartTaskRunDtoStartedByEnum = {
    User: 'user',
    Autopilot: 'autopilot'
} as const;
export type StartTaskRunDtoStartedByEnum = typeof StartTaskRunDtoStartedByEnum[keyof typeof StartTaskRunDtoStartedByEnum];

/**
 * 
 * @export
 * @interface StartTeamChatDto
 */
export interface StartTeamChatDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof StartTeamChatDto
     */
    agentKind: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof StartTeamChatDto
     */
    model?: string;
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof StartTeamChatDto
     */
    approval?: ChatApprovalMode;
    /**
     * 
     * @type {string}
     * @memberof StartTeamChatDto
     */
    effort?: string;
    /**
     * 
     * @type {string}
     * @memberof StartTeamChatDto
     */
    contextWindow?: string;
    /**
     * 
     * @type {number}
     * @memberof StartTeamChatDto
     */
    autoCompactPercent?: number;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof StartTeamChatDto
     */
    modelParameters?: { [key: string]: string; };
    /**
     * 
     * @type {string}
     * @memberof StartTeamChatDto
     */
    configDir?: string;
    /**
     * 
     * @type {string}
     * @memberof StartTeamChatDto
     */
    customInstructions?: string;
    /**
     * 
     * @type {string}
     * @memberof StartTeamChatDto
     */
    replyLanguage?: string;
    /**
     * 
     * @type {{ [key: string]: { [key: string]: boolean; }; }}
     * @memberof StartTeamChatDto
     */
    agentOptions?: { [key: string]: { [key: string]: boolean; }; };
}


/**
 * 
 * @export
 * @interface StopDetachedProcessesDto
 */
export interface StopDetachedProcessesDto {
    /**
     * 
     * @type {Array<number>}
     * @memberof StopDetachedProcessesDto
     */
    pids?: Array<number>;
    /**
     * monitors to stop; each ends `stopped` and wakes its agent
     * @type {Array<string>}
     * @memberof StopDetachedProcessesDto
     */
    monitorIds?: Array<string>;
}
/**
 * 
 * @export
 * @interface StoppedDetachedProcessesDto
 */
export interface StoppedDetachedProcessesDto {
    /**
     * 
     * @type {Array<number>}
     * @memberof StoppedDetachedProcessesDto
     */
    stoppedPids: Array<number>;
    /**
     * 
     * @type {Array<string>}
     * @memberof StoppedDetachedProcessesDto
     */
    stoppedMonitorIds: Array<string>;
}
/**
 * 
 * @export
 * @interface StoppedResourceAlertCommandDto
 */
export interface StoppedResourceAlertCommandDto {
    /**
     * 
     * @type {Array<number>}
     * @memberof StoppedResourceAlertCommandDto
     */
    stoppedPids: Array<number>;
}
/**
 * 
 * @export
 * @interface StorageArchivedPeriod
 */
export interface StorageArchivedPeriod {
    /**
     * 
     * @type {number}
     * @memberof StorageArchivedPeriod
     */
    days: number | null;
    /**
     * How many chats were archived at or before the cutoff
     * @type {number}
     * @memberof StorageArchivedPeriod
     */
    count: number;
    /**
     * The cutoff, posted back to delete exactly what was counted
     * @type {string}
     * @memberof StorageArchivedPeriod
     */
    archivedBefore: string;
}
/**
 * 
 * @export
 * @interface StorageCleanDto
 */
export interface StorageCleanDto {
    /**
     * 
     * @type {StorageCleanTarget}
     * @memberof StorageCleanDto
     */
    target: StorageCleanTarget;
    /**
     * Required for archivedChats: delete those archived at or before this instant
     * @type {string}
     * @memberof StorageCleanDto
     */
    archivedBefore?: string;
}


/**
 * 
 * @export
 * @interface StorageCleanOption
 */
export interface StorageCleanOption {
    /**
     * 
     * @type {StorageCleanTarget}
     * @memberof StorageCleanOption
     */
    target: StorageCleanTarget;
    /**
     * How many chats, files or folders it removes
     * @type {number}
     * @memberof StorageCleanOption
     */
    count: number;
    /**
     * 
     * @type {number}
     * @memberof StorageCleanOption
     */
    bytes: number | null;
}



/**
 * 
 * @export
 */
export const StorageCleanTarget = {
    ArchivedChats: 'archivedChats',
    CompactDatabase: 'compactDatabase',
    OrphanChatFiles: 'orphanChatFiles',
    OrphanTaskFiles: 'orphanTaskFiles',
    TeamBackups: 'teamBackups',
    Logs: 'logs',
    Leftovers: 'leftovers',
    SettingsCopies: 'settingsCopies'
} as const;
export type StorageCleanTarget = typeof StorageCleanTarget[keyof typeof StorageCleanTarget];

/**
 * 
 * @export
 * @interface StorageEntry
 */
export interface StorageEntry {
    /**
     * The path under the data folder
     * @type {string}
     * @memberof StorageEntry
     */
    name: string;
    /**
     * Space it takes on disk
     * @type {number}
     * @memberof StorageEntry
     */
    bytes: number;
}
/**
 * 
 * @export
 * @interface StorageGroup
 */
export interface StorageGroup {
    /**
     * 
     * @type {string}
     * @memberof StorageGroup
     */
    id: StorageGroupIdEnum;
    /**
     * 
     * @type {number}
     * @memberof StorageGroup
     */
    bytes: number;
    /**
     * 
     * @type {Array<StorageEntry>}
     * @memberof StorageGroup
     */
    entries: Array<StorageEntry>;
    /**
     * 
     * @type {Array<StorageCleanOption>}
     * @memberof StorageGroup
     */
    clean: Array<StorageCleanOption>;
}


/**
 * @export
 */
export const StorageGroupIdEnum = {
    Database: 'database',
    ChatFiles: 'chatFiles',
    AgentSessions: 'agentSessions',
    TaskFiles: 'taskFiles',
    Teams: 'teams',
    TeamBackups: 'teamBackups',
    Logs: 'logs',
    Caches: 'caches',
    AppState: 'appState',
    Leftovers: 'leftovers',
    SettingsCopies: 'settingsCopies'
} as const;
export type StorageGroupIdEnum = typeof StorageGroupIdEnum[keyof typeof StorageGroupIdEnum];

/**
 * 
 * @export
 * @interface StorageJob
 */
export interface StorageJob {
    /**
     * 
     * @type {StorageCleanTarget}
     * @memberof StorageJob
     */
    target: StorageCleanTarget;
    /**
     * 
     * @type {string}
     * @memberof StorageJob
     */
    state: StorageJobStateEnum;
    /**
     * 
     * @type {string}
     * @memberof StorageJob
     */
    startedAt: string;
    /**
     * 
     * @type {string}
     * @memberof StorageJob
     */
    finishedAt: string | null;
    /**
     * 
     * @type {number}
     * @memberof StorageJob
     */
    removed: number;
    /**
     * 
     * @type {number}
     * @memberof StorageJob
     */
    freedBytes: number | null;
    /**
     * 
     * @type {string}
     * @memberof StorageJob
     */
    error: string | null;
}


/**
 * @export
 */
export const StorageJobStateEnum = {
    Scheduled: 'scheduled',
    Running: 'running',
    Done: 'done',
    Failed: 'failed'
} as const;
export type StorageJobStateEnum = typeof StorageJobStateEnum[keyof typeof StorageJobStateEnum];

/**
 * 
 * @export
 * @interface StorageJobReadDto
 */
export interface StorageJobReadDto {
    /**
     * 
     * @type {StorageJob}
     * @memberof StorageJobReadDto
     */
    job: StorageJob | null;
}
/**
 * 
 * @export
 * @interface StorageUsageDto
 */
export interface StorageUsageDto {
    /**
     * The data folder every entry is under
     * @type {string}
     * @memberof StorageUsageDto
     */
    root: string;
    /**
     * 
     * @type {string}
     * @memberof StorageUsageDto
     */
    scannedAt: string;
    /**
     * 
     * @type {Array<StorageGroup>}
     * @memberof StorageUsageDto
     */
    groups: Array<StorageGroup>;
    /**
     * 
     * @type {StorageUsageDtoChats}
     * @memberof StorageUsageDto
     */
    chats: StorageUsageDtoChats;
    /**
     * Top-level names the daemon does not own — the desktop app's own files, measured by Electron main
     * @type {Array<string>}
     * @memberof StorageUsageDto
     */
    unclaimed: Array<string>;
    /**
     * 
     * @type {StorageJob}
     * @memberof StorageUsageDto
     */
    job: StorageJob | null;
}
/**
 * 
 * @export
 * @interface StorageUsageDtoChats
 */
export interface StorageUsageDtoChats {
    /**
     * 
     * @type {number}
     * @memberof StorageUsageDtoChats
     */
    active: number;
    /**
     * 
     * @type {number}
     * @memberof StorageUsageDtoChats
     */
    archived: number;
    /**
     * 
     * @type {Array<StorageArchivedPeriod>}
     * @memberof StorageUsageDtoChats
     */
    archivedPeriods: Array<StorageArchivedPeriod>;
}
/**
 * 
 * @export
 * @interface SweepArchivedDto
 */
export interface SweepArchivedDto {
    /**
     * Delete chats archived at least this many days ago
     * @type {number}
     * @memberof SweepArchivedDto
     */
    olderThanDays: number;
}
/**
 * 
 * @export
 * @interface SweptArchivedDto
 */
export interface SweptArchivedDto {
    /**
     * Archived chats permanently deleted by this sweep
     * @type {number}
     * @memberof SweptArchivedDto
     */
    deleted: number;
}
/**
 * 
 * @export
 * @interface TaskAttachment
 */
export interface TaskAttachment {
    /**
     * The absolute path this file is referenced by
     * @type {string}
     * @memberof TaskAttachment
     */
    path: string;
    /**
     * What to call it — the file’s own name
     * @type {string}
     * @memberof TaskAttachment
     */
    name: string;
}
/**
 * 
 * @export
 * @interface TaskAwaitingMergeDto
 */
export interface TaskAwaitingMergeDto {
    /**
     * 
     * @type {string}
     * @memberof TaskAwaitingMergeDto
     */
    taskId: string;
    /**
     * 
     * @type {string}
     * @memberof TaskAwaitingMergeDto
     */
    projectId: string;
    /**
     * For the watcher’s own log lines
     * @type {string}
     * @memberof TaskAwaitingMergeDto
     */
    title: string;
    /**
     * Every pull request this card’s run opened, oldest first
     * @type {Array<RunPullRequest>}
     * @memberof TaskAwaitingMergeDto
     */
    pullRequests: Array<RunPullRequest>;
    /**
     * 
     * @type {string}
     * @memberof TaskAwaitingMergeDto
     */
    lastDoneAt: string | null;
}
/**
 * 
 * @export
 * @interface TaskDeletedDto
 */
export interface TaskDeletedDto {
    /**
     * True when the task row was removed
     * @type {boolean}
     * @memberof TaskDeletedDto
     */
    deleted: boolean;
}
/**
 * 
 * @export
 * @interface TaskDto
 */
export interface TaskDto {
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    projectId: string;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    title: string;
    /**
     * 
     * @type {number}
     * @memberof TaskDto
     */
    number: number | null;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    description: string | null;
    /**
     * Files bound to this card, in the order they were attached
     * @type {Array<TaskFile>}
     * @memberof TaskDto
     */
    attachments: Array<TaskFile>;
    /**
     * 
     * @type {TaskStatus}
     * @memberof TaskDto
     */
    status: TaskStatus;
    /**
     * 
     * @type {Array<string>}
     * @memberof TaskDto
     */
    labels: Array<string>;
    /**
     * 
     * @type {TaskSource}
     * @memberof TaskDto
     */
    source: TaskSource;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    sourceRef: string | null;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    folder: string | null;
    /**
     * 
     * @type {AgentKind}
     * @memberof TaskDto
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    model: string | null;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    effort: string | null;
    /**
     * Every other model setting this card runs with, keyed by the CLI's own parameter id; {} means take the project's
     * @type {{ [key: string]: string; }}
     * @memberof TaskDto
     */
    modelParameters: { [key: string]: string; };
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof TaskDto
     */
    approval: ChatApprovalMode | null;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    configDir: string | null;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    teamSlug: string | null;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    branch: string | null;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    worktreePath: string | null;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    runId: string | null;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    report: string | null;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    reportedAt: string | null;
    /**
     * Pull requests the task's run opened, oldest first, as captured from the agent output
     * @type {Array<RunPullRequest>}
     * @memberof TaskDto
     */
    pullRequests: Array<RunPullRequest>;
    /**
     * 
     * @type {TaskStageLine}
     * @memberof TaskDto
     */
    stage: TaskStageLine | null;
    /**
     * Order within the column, ascending and unique — gaps are expected, since a delete or a move leaves one and nothing renumbers
     * @type {number}
     * @memberof TaskDto
     */
    position: number;
    /**
     * How urgent this task is; 'none' until someone triages it
     * @type {TaskPriority}
     * @memberof TaskDto
     */
    priority: TaskPriority;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    dueDate: string | null;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    createdAt: string;
    /**
     * 
     * @type {string}
     * @memberof TaskDto
     */
    updatedAt: string;
}


/**
 * 
 * @export
 * @interface TaskFile
 */
export interface TaskFile {
    /**
     * Stable within this card, so a row can be removed
     * @type {string}
     * @memberof TaskFile
     */
    id: string;
    /**
     * The file’s own name, for the list
     * @type {string}
     * @memberof TaskFile
     */
    name: string;
    /**
     * Where it is on this machine
     * @type {string}
     * @memberof TaskFile
     */
    path: string;
    /**
     * 
     * @type {number}
     * @memberof TaskFile
     */
    bytes: number | null;
}

/**
 * 
 * @export
 */
export const TaskPriority = {
    None: 'none',
    Urgent: 'urgent',
    High: 'high',
    Medium: 'medium',
    Low: 'low'
} as const;
export type TaskPriority = typeof TaskPriority[keyof typeof TaskPriority];


/**
 * 
 * @export
 */
export const TaskSource = {
    Geniro: 'geniro'
} as const;
export type TaskSource = typeof TaskSource[keyof typeof TaskSource];

/**
 * 
 * @export
 * @interface TaskStageLine
 */
export interface TaskStageLine {
    /**
     * 
     * @type {string}
     * @memberof TaskStageLine
     */
    title: string | null;
    /**
     * 
     * @type {number}
     * @memberof TaskStageLine
     */
    index: number;
    /**
     * 
     * @type {number}
     * @memberof TaskStageLine
     */
    total: number;
}

/**
 * 
 * @export
 */
export const TaskStatus = {
    Backlog: 'backlog',
    Todo: 'todo',
    InProgress: 'in_progress',
    InReview: 'in_review',
    Done: 'done',
    Failed: 'failed'
} as const;
export type TaskStatus = typeof TaskStatus[keyof typeof TaskStatus];

/**
 * 
 * @export
 * @interface Team
 */
export interface Team {
    /**
     * Human-readable team name
     * @type {string}
     * @memberof Team
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof Team
     */
    description?: string;
    /**
     * Cap on callee turns working at once across the run; omitted = the machine ceiling
     * @type {number}
     * @memberof Team
     */
    maxActiveTurns?: number;
    /**
     * How the team coordinates: 'lead' (the trigger's member runs the work) or 'relay' (stages pass between their responsible members)
     * @type {TeamMode}
     * @memberof Team
     */
    mode: TeamMode;
    /**
     * 
     * @type {Array<TeamMember>}
     * @memberof Team
     */
    members: Array<TeamMember>;
    /**
     * What starts a run — exactly one, the first message
     * @type {Array<TeamTrigger>}
     * @memberof Team
     */
    triggers: Array<TeamTrigger>;
    /**
     * 
     * @type {Array<InstructionBlock>}
     * @memberof Team
     */
    instructionBlocks: Array<InstructionBlock>;
    /**
     * The team's stage graph: the steps every run walks, in order, e.g. investigation → implementation | fix → review. Every member of a run sees it and moves it with move_stage. Omitted = the team has no stages
     * @type {Array<TeamStage>}
     * @memberof Team
     */
    stages?: Array<TeamStage>;
    /**
     * Whether this team's runs are offered lessons reflections; omitted = inherit the project's and the app's setting. The app's Off always wins
     * @type {LessonOverride}
     * @memberof Team
     */
    lessons?: LessonOverride;
}


/**
 * 
 * @export
 * @interface TeamAgentPoolMember
 */
export interface TeamAgentPoolMember {
    /**
     * CLI agent this member runs
     * @type {AgentKind}
     * @memberof TeamAgentPoolMember
     */
    agent: AgentKind;
    /**
     * Tool-approval mode for this member; omitted = the member's own
     * @type {ApprovalMode}
     * @memberof TeamAgentPoolMember
     */
    approval?: ApprovalMode;
    /**
     * Auto-compact threshold (% of the context window); omitted = never
     * @type {number}
     * @memberof TeamAgentPoolMember
     */
    autoCompactPercent?: number;
    /**
     * Model alias; omitted = CLI default
     * @type {string}
     * @memberof TeamAgentPoolMember
     */
    model?: string;
    /**
     * Reasoning-effort level; omitted = CLI default
     * @type {string}
     * @memberof TeamAgentPoolMember
     */
    effort?: string;
    /**
     * Context-window size; omitted = the model's own default
     * @type {string}
     * @memberof TeamAgentPoolMember
     */
    contextWindow?: string;
    /**
     * Other model settings, keyed by the CLI's own parameter id; omitted = the model's own defaults
     * @type {{ [key: string]: string; }}
     * @memberof TeamAgentPoolMember
     */
    modelParameters?: { [key: string]: string; };
    /**
     * Absolute path to the agent config directory this member runs under
     * @type {string}
     * @memberof TeamAgentPoolMember
     */
    configDir?: string;
    /**
     * MCP servers this member’s turns run without, by name; omitted = none switched off
     * @type {Array<string>}
     * @memberof TeamAgentPoolMember
     */
    mcpDisabled?: Array<string>;
}


/**
 * 
 * @export
 * @interface TeamAvatarDataDto
 */
export interface TeamAvatarDataDto {
    /**
     * `data:<mediaType>;base64,<bytes>`
     * @type {string}
     * @memberof TeamAvatarDataDto
     */
    dataUri: string;
}
/**
 * 
 * @export
 * @interface TeamAvatarIdDto
 */
export interface TeamAvatarIdDto {
    /**
     * The stored file id, `<sha256>.<ext>`
     * @type {string}
     * @memberof TeamAvatarIdDto
     */
    id: string;
}
/**
 * 
 * @export
 * @interface TeamChatsDiscardedDto
 */
export interface TeamChatsDiscardedDto {
    /**
     * 
     * @type {number}
     * @memberof TeamChatsDiscardedDto
     */
    deleted: number;
}
/**
 * 
 * @export
 * @interface TeamDeletedDto
 */
export interface TeamDeletedDto {
    /**
     * 
     * @type {boolean}
     * @memberof TeamDeletedDto
     */
    deleted: boolean;
}
/**
 * 
 * @export
 * @interface TeamFileDto
 */
export interface TeamFileDto {
    /**
     * 
     * @type {string}
     * @memberof TeamFileDto
     */
    slug: string;
    /**
     * 
     * @type {Team}
     * @memberof TeamFileDto
     */
    team: Team;
    /**
     * The file's version as stored — send it back as a save's `baseHash` so a save over a newer file is refused
     * @type {string}
     * @memberof TeamFileDto
     */
    hash: string;
}
/**
 * 
 * @export
 * @interface TeamHealthDto
 */
export interface TeamHealthDto {
    /**
     * 
     * @type {string}
     * @memberof TeamHealthDto
     */
    slug: string;
    /**
     * ISO time the answer was composed
     * @type {string}
     * @memberof TeamHealthDto
     */
    checkedAt: string;
    /**
     * A problem of level error stands, so a run cannot start
     * @type {boolean}
     * @memberof TeamHealthDto
     */
    blocking: boolean;
    /**
     * Problems of the team itself
     * @type {Array<HealthProblem>}
     * @memberof TeamHealthDto
     */
    team: Array<HealthProblem>;
    /**
     * 
     * @type {Array<MemberHealth>}
     * @memberof TeamHealthDto
     */
    members: Array<MemberHealth>;
}
/**
 * 
 * @export
 * @interface TeamMember
 */
export interface TeamMember {
    /**
     * Unique member id within the team
     * @type {string}
     * @memberof TeamMember
     */
    id: string;
    /**
     * Display name, and how other members address it
     * @type {string}
     * @memberof TeamMember
     */
    name: string;
    /**
     * Manner and tone; only this member’s own prompt carries it
     * @type {string}
     * @memberof TeamMember
     */
    character?: string;
    /**
     * 
     * @type {MemberAvatar}
     * @memberof TeamMember
     */
    avatar?: MemberAvatar;
    /**
     * What this member does — shown to every other member
     * @type {string}
     * @memberof TeamMember
     */
    role?: string;
    /**
     * How this member works — only its own turns carry it
     * @type {string}
     * @memberof TeamMember
     */
    instructions?: string;
    /**
     * CLI agent this member runs
     * @type {AgentKind}
     * @memberof TeamMember
     */
    agent: AgentKind;
    /**
     * Model alias; omitted = CLI default
     * @type {string}
     * @memberof TeamMember
     */
    model?: string;
    /**
     * Reasoning-effort level; omitted = CLI default
     * @type {string}
     * @memberof TeamMember
     */
    effort?: string;
    /**
     * Context-window size; omitted = the model's own default
     * @type {string}
     * @memberof TeamMember
     */
    contextWindow?: string;
    /**
     * Auto-compact threshold (% of the context window); omitted = never
     * @type {number}
     * @memberof TeamMember
     */
    autoCompactPercent?: number;
    /**
     * Other model settings, keyed by the CLI's own parameter id; omitted = the model's own defaults
     * @type {{ [key: string]: string; }}
     * @memberof TeamMember
     */
    modelParameters?: { [key: string]: string; };
    /**
     * Tool-approval mode for this member
     * @type {ApprovalMode}
     * @memberof TeamMember
     */
    approval: ApprovalMode;
    /**
     * Absolute path to the agent config directory this member runs under
     * @type {string}
     * @memberof TeamMember
     */
    configDir?: string;
    /**
     * MCP servers this member’s turns run without, by name; omitted = none switched off
     * @type {Array<string>}
     * @memberof TeamMember
     */
    mcpDisabled?: Array<string>;
    /**
     * Further agent configurations a turn of this member can run under (members 2, 3, …); the member’s own settings are member 1
     * @type {Array<TeamAgentPoolMember>}
     * @memberof TeamMember
     */
    pool?: Array<TeamAgentPoolMember>;
}



/**
 * 
 * @export
 */
export const TeamMode = {
    Lead: 'lead',
    Relay: 'relay'
} as const;
export type TeamMode = typeof TeamMode[keyof typeof TeamMode];

/**
 * 
 * @export
 * @interface TeamNote
 */
export interface TeamNote {
    /**
     * the row that holds it; its id
     * @type {number}
     * @memberof TeamNote
     */
    seq: number;
    /**
     * 
     * @type {TeamNoteKind}
     * @memberof TeamNote
     */
    kind: TeamNoteKind;
    /**
     * 
     * @type {string}
     * @memberof TeamNote
     */
    text: string;
    /**
     * the agent that wrote it
     * @type {string}
     * @memberof TeamNote
     */
    memberId: string;
    /**
     * 
     * @type {string}
     * @memberof TeamNote
     */
    conversationId: string | null;
    /**
     * 
     * @type {string}
     * @memberof TeamNote
     */
    callId: string | null;
    /**
     * ISO-8601
     * @type {string}
     * @memberof TeamNote
     */
    createdAt: string;
    /**
     * 
     * @type {number}
     * @memberof TeamNote
     */
    supersedes: number | null;
    /**
     * 
     * @type {number}
     * @memberof TeamNote
     */
    supersededBy: number | null;
}



/**
 * 
 * @export
 */
export const TeamNoteKind = {
    Contract: 'contract',
    Decision: 'decision',
    Fact: 'fact',
    Pitfall: 'pitfall',
    Pointer: 'pointer'
} as const;
export type TeamNoteKind = typeof TeamNoteKind[keyof typeof TeamNoteKind];

/**
 * 
 * @export
 * @interface TeamOverlay
 */
export interface TeamOverlay {
    /**
     * Defaults for every member (and pool member) of one CLI
     * @type {{ [key: string]: TeamOverlayAgentDefaults; }}
     * @memberof TeamOverlay
     */
    allMembers?: { [key: string]: TeamOverlayAgentDefaults; };
    /**
     * Per-member overrides, keyed by member id
     * @type {{ [key: string]: TeamOverlayMember; }}
     * @memberof TeamOverlay
     */
    members?: { [key: string]: TeamOverlayMember; };
    /**
     * Team-scoped blocks for this project, after the team’s own
     * @type {Array<InstructionBlock>}
     * @memberof TeamOverlay
     */
    instructionBlocks?: Array<InstructionBlock>;
}
/**
 * 
 * @export
 * @interface TeamOverlayAgentDefaults
 */
export interface TeamOverlayAgentDefaults {
    /**
     * Model alias; omitted = CLI default
     * @type {string}
     * @memberof TeamOverlayAgentDefaults
     */
    model?: string;
    /**
     * Reasoning-effort level; omitted = CLI default
     * @type {string}
     * @memberof TeamOverlayAgentDefaults
     */
    effort?: string;
    /**
     * Context-window size; omitted = the model's own default
     * @type {string}
     * @memberof TeamOverlayAgentDefaults
     */
    contextWindow?: string;
    /**
     * Other model settings, keyed by the CLI's own parameter id; omitted = the model's own defaults
     * @type {{ [key: string]: string; }}
     * @memberof TeamOverlayAgentDefaults
     */
    modelParameters?: { [key: string]: string; };
    /**
     * Auto-compact threshold (% of the context window); omitted = never
     * @type {number}
     * @memberof TeamOverlayAgentDefaults
     */
    autoCompactPercent?: number;
    /**
     * Tool-approval mode; omitted = the team’s
     * @type {ApprovalMode}
     * @memberof TeamOverlayAgentDefaults
     */
    approval?: ApprovalMode;
    /**
     * Absolute path to the agent config directory this member runs under
     * @type {string}
     * @memberof TeamOverlayAgentDefaults
     */
    configDir?: string;
}


/**
 * 
 * @export
 * @interface TeamOverlayDto
 */
export interface TeamOverlayDto {
    /**
     * 
     * @type {string}
     * @memberof TeamOverlayDto
     */
    slug: string;
    /**
     * 
     * @type {string}
     * @memberof TeamOverlayDto
     */
    projectId: string;
    /**
     * 
     * @type {TeamOverlay}
     * @memberof TeamOverlayDto
     */
    overlay: TeamOverlay;
    /**
     * 
     * @type {string}
     * @memberof TeamOverlayDto
     */
    hash: string | null;
    /**
     * Overlay entries naming a member or stage the team no longer has, e.g. `members.reviewer`
     * @type {Array<string>}
     * @memberof TeamOverlayDto
     */
    orphans: Array<string>;
}
/**
 * 
 * @export
 * @interface TeamOverlayMember
 */
export interface TeamOverlayMember {
    /**
     * 
     * @type {TeamOverlayMemberSettings}
     * @memberof TeamOverlayMember
     */
    settings?: TeamOverlayMemberSettings;
    /**
     * Appended to the member’s own instructions in this project
     * @type {string}
     * @memberof TeamOverlayMember
     */
    extraInstructions?: string;
    /**
     * Replaces the member’s whole pool (members 2, 3, …) in this project; [] = no pool; omitted = the team’s pool
     * @type {Array<TeamAgentPoolMember>}
     * @memberof TeamOverlayMember
     */
    pool?: Array<TeamAgentPoolMember>;
    /**
     * Replaces the member’s own MCP switches in this project: the servers it runs without; [] = none off; omitted = the team’s
     * @type {Array<string>}
     * @memberof TeamOverlayMember
     */
    mcpDisabled?: Array<string>;
}
/**
 * 
 * @export
 * @interface TeamOverlayMemberSettings
 */
export interface TeamOverlayMemberSettings {
    /**
     * Model alias; omitted = CLI default
     * @type {string}
     * @memberof TeamOverlayMemberSettings
     */
    model?: string;
    /**
     * Reasoning-effort level; omitted = CLI default
     * @type {string}
     * @memberof TeamOverlayMemberSettings
     */
    effort?: string;
    /**
     * Context-window size; omitted = the model's own default
     * @type {string}
     * @memberof TeamOverlayMemberSettings
     */
    contextWindow?: string;
    /**
     * Other model settings, keyed by the CLI's own parameter id; omitted = the model's own defaults
     * @type {{ [key: string]: string; }}
     * @memberof TeamOverlayMemberSettings
     */
    modelParameters?: { [key: string]: string; };
    /**
     * Auto-compact threshold (% of the context window); omitted = never
     * @type {number}
     * @memberof TeamOverlayMemberSettings
     */
    autoCompactPercent?: number;
    /**
     * Tool-approval mode; omitted = the team’s
     * @type {ApprovalMode}
     * @memberof TeamOverlayMemberSettings
     */
    approval?: ApprovalMode;
    /**
     * Absolute path to the agent config directory this member runs under
     * @type {string}
     * @memberof TeamOverlayMemberSettings
     */
    configDir?: string;
    /**
     * CLI agent this member runs in the project; omitted = the team’s
     * @type {AgentKind}
     * @memberof TeamOverlayMemberSettings
     */
    agent?: AgentKind;
}


/**
 * 
 * @export
 * @interface TeamOverlayScope
 */
export interface TeamOverlayScope {
    /**
     * 
     * @type {string}
     * @memberof TeamOverlayScope
     */
    projectId: string;
    /**
     * 
     * @type {string}
     * @memberof TeamOverlayScope
     */
    projectName: string;
    /**
     * True while the project's default team is this team — only then does a run apply the overlay
     * @type {boolean}
     * @memberof TeamOverlayScope
     */
    active: boolean;
    /**
     * 
     * @type {string}
     * @memberof TeamOverlayScope
     */
    defaultTeamSlug: string | null;
    /**
     * 
     * @type {string}
     * @memberof TeamOverlayScope
     */
    defaultTeamName: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof TeamOverlayScope
     */
    hasOverlay: boolean;
    /**
     * 
     * @type {string}
     * @memberof TeamOverlayScope
     */
    hash: string | null;
    /**
     * Model-group fields and pools the overlay overrides
     * @type {number}
     * @memberof TeamOverlayScope
     */
    overrides: number;
    /**
     * Overlay instruction blocks
     * @type {number}
     * @memberof TeamOverlayScope
     */
    blocks: number;
    /**
     * Members with extra instructions
     * @type {number}
     * @memberof TeamOverlayScope
     */
    notes: number;
    /**
     * 
     * @type {Array<string>}
     * @memberof TeamOverlayScope
     */
    orphans: Array<string>;
    /**
     * 
     * @type {string}
     * @memberof TeamOverlayScope
     */
    unreadable: string | null;
}
/**
 * 
 * @export
 * @interface TeamOverlayScopesDto
 */
export interface TeamOverlayScopesDto {
    /**
     * 
     * @type {Array<TeamOverlayScope>}
     * @memberof TeamOverlayScopesDto
     */
    scopes: Array<TeamOverlayScope>;
}
/**
 * 
 * @export
 * @interface TeamPortraitMember
 */
export interface TeamPortraitMember {
    /**
     * 
     * @type {string}
     * @memberof TeamPortraitMember
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof TeamPortraitMember
     */
    name: string;
    /**
     * 
     * @type {MemberAvatar}
     * @memberof TeamPortraitMember
     */
    avatar?: MemberAvatar;
}
/**
 * 
 * @export
 * @interface TeamRemovedDto
 */
export interface TeamRemovedDto {
    /**
     * 
     * @type {boolean}
     * @memberof TeamRemovedDto
     */
    deleted: boolean;
    /**
     * Handles a move to Global changed, because Global held them
     * @type {Array<TeamRemovedDtoKnowledgeRenamedInner>}
     * @memberof TeamRemovedDto
     */
    knowledgeRenamed: Array<TeamRemovedDtoKnowledgeRenamedInner>;
}
/**
 * 
 * @export
 * @interface TeamRemovedDtoKnowledgeRenamedInner
 */
export interface TeamRemovedDtoKnowledgeRenamedInner {
    /**
     * 
     * @type {string}
     * @memberof TeamRemovedDtoKnowledgeRenamedInner
     */
    from: string;
    /**
     * 
     * @type {string}
     * @memberof TeamRemovedDtoKnowledgeRenamedInner
     */
    to: string;
}
/**
 * 
 * @export
 * @interface TeamStage
 */
export interface TeamStage {
    /**
     * Stable stage id: lowercase letters, digits and '-', at most 40 characters, never all digits (e.g. 'investigation')
     * @type {string}
     * @memberof TeamStage
     */
    id: string;
    /**
     * Short stage name shown to members and the user
     * @type {string}
     * @memberof TeamStage
     */
    title: string;
    /**
     * How to work in this stage, in plain language
     * @type {string}
     * @memberof TeamStage
     */
    howToWork?: string;
    /**
     * The condition that makes this stage done
     * @type {string}
     * @memberof TeamStage
     */
    goal: string;
    /**
     * When true, the stage cannot be completed until the run has recorded its goals with the goals tool
     * @type {boolean}
     * @memberof TeamStage
     */
    requireGoals?: boolean;
    /**
     * Ids of the members responsible for this stage; the first one leads it
     * @type {Array<string>}
     * @memberof TeamStage
     */
    responsible?: Array<string>;
    /**
     * Ids of the stages that may follow; two or more = the run takes ONE of them; omitted = a final stage
     * @type {Array<string>}
     * @memberof TeamStage
     */
    next?: Array<string>;
}
/**
 * 
 * @export
 * @interface TeamStatsDay
 */
export interface TeamStatsDay {
    /**
     * YYYY-MM-DD, the machine’s local day
     * @type {string}
     * @memberof TeamStatsDay
     */
    day: string;
    /**
     * runs that started that day
     * @type {number}
     * @memberof TeamStatsDay
     */
    runs: number;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsDay
     */
    costUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsDay
     */
    turns: number;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsDay
     */
    workedMs: number | null;
    /**
     * pull request outcomes recorded that day
     * @type {number}
     * @memberof TeamStatsDay
     */
    outcomes: number;
}
/**
 * 
 * @export
 * @interface TeamStatsDto
 */
export interface TeamStatsDto {
    /**
     * 
     * @type {string}
     * @memberof TeamStatsDto
     */
    slug: string;
    /**
     * every thread row of the team
     * @type {number}
     * @memberof TeamStatsDto
     */
    runs: number;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsDto
     */
    costUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsDto
     */
    estimatedCostUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsDto
     */
    turns: number;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsDto
     */
    workedMs: number | null;
    /**
     * the part of workedMs geniro measured by the clock (`wall_turns`), which a deleted run takes with it
     * @type {number}
     * @memberof TeamStatsDto
     */
    measuredWorkedMs: number;
    /**
     * 
     * @type {TeamStatsOutcomes}
     * @memberof TeamStatsDto
     */
    outcomes: TeamStatsOutcomes;
    /**
     * oldest first, only the days with activity
     * @type {Array<TeamStatsDay>}
     * @memberof TeamStatsDto
     */
    days: Array<TeamStatsDay>;
    /**
     * most expensive first; turns recorded with no member are in the totals only
     * @type {Array<TeamStatsMember>}
     * @memberof TeamStatsDto
     */
    byMember: Array<TeamStatsMember>;
    /**
     * 
     * @type {TeamStatsDtoAssessmentVerdicts}
     * @memberof TeamStatsDto
     */
    assessmentVerdicts: TeamStatsDtoAssessmentVerdicts;
    /**
     * 
     * @type {ThreadMetrics}
     * @memberof TeamStatsDto
     */
    metrics: ThreadMetrics;
}
/**
 * how often the user agreed with the analyses’ marks
 * @export
 * @interface TeamStatsDtoAssessmentVerdicts
 */
export interface TeamStatsDtoAssessmentVerdicts {
    /**
     * every member assessment filed
     * @type {number}
     * @memberof TeamStatsDtoAssessmentVerdicts
     */
    assessments: number;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsDtoAssessmentVerdicts
     */
    agreed: number;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsDtoAssessmentVerdicts
     */
    disagreed: number;
}
/**
 * 
 * @export
 * @interface TeamStatsMember
 */
export interface TeamStatsMember {
    /**
     * 
     * @type {string}
     * @memberof TeamStatsMember
     */
    memberId: string;
    /**
     * 
     * @type {string}
     * @memberof TeamStatsMember
     */
    agentKind: string | null;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsMember
     */
    costUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsMember
     */
    turns: number;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsMember
     */
    workedMs: number | null;
    /**
     * the part of workedMs geniro measured by the clock
     * @type {number}
     * @memberof TeamStatsMember
     */
    measuredWorkedMs: number;
    /**
     * runs it took part in
     * @type {number}
     * @memberof TeamStatsMember
     */
    runs: number;
    /**
     * 
     * @type {TeamStatsMemberPerRun}
     * @memberof TeamStatsMember
     */
    perRun: TeamStatsMemberPerRun;
    /**
     * 
     * @type {MemberWork}
     * @memberof TeamStatsMember
     */
    work: MemberWork | null;
    /**
     * every change between versions that touched it, newest first
     * @type {Array<MemberChange>}
     * @memberof TeamStatsMember
     */
    changes: Array<MemberChange>;
    /**
     * every analysis that judged it, newest first
     * @type {Array<MemberAssessmentEntry>}
     * @memberof TeamStatsMember
     */
    assessments: Array<MemberAssessmentEntry>;
}
/**
 * how its cost and working time spread over the runs it took part in; null when none was priced or timed
 * @export
 * @interface TeamStatsMemberPerRun
 */
export interface TeamStatsMemberPerRun {
    /**
     * 
     * @type {FigureSpread}
     * @memberof TeamStatsMemberPerRun
     */
    costUsd: FigureSpread | null;
    /**
     * 
     * @type {FigureSpread}
     * @memberof TeamStatsMemberPerRun
     */
    workedMs: FigureSpread | null;
}
/**
 * 
 * @export
 * @interface TeamStatsOutcomes
 */
export interface TeamStatsOutcomes {
    /**
     * 
     * @type {number}
     * @memberof TeamStatsOutcomes
     */
    total: number;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsOutcomes
     */
    accepted: number;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsOutcomes
     */
    changesRequested: number;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsOutcomes
     */
    notYet: number;
    /**
     * 
     * @type {number}
     * @memberof TeamStatsOutcomes
     */
    notNeeded: number;
}
/**
 * 
 * @export
 * @interface TeamSummaryDto
 */
export interface TeamSummaryDto {
    /**
     * Library file name without the .team.yaml suffix
     * @type {string}
     * @memberof TeamSummaryDto
     */
    slug: string;
    /**
     * 
     * @type {string}
     * @memberof TeamSummaryDto
     */
    name: string;
    /**
     * 
     * @type {string}
     * @memberof TeamSummaryDto
     */
    description: string | null;
    /**
     * 
     * @type {number}
     * @memberof TeamSummaryDto
     */
    memberCount: number;
    /**
     * 
     * @type {number}
     * @memberof TeamSummaryDto
     */
    stageCount: number;
    /**
     * Per-agent-kind member counts, only kinds present, stable order
     * @type {Array<AgentCount>}
     * @memberof TeamSummaryDto
     */
    agentCounts: Array<AgentCount>;
    /**
     * The first members in team order, drawn on the library card
     * @type {Array<TeamPortraitMember>}
     * @memberof TeamSummaryDto
     */
    portrait: Array<TeamPortraitMember>;
    /**
     * 
     * @type {string}
     * @memberof TeamSummaryDto
     */
    updatedAt: string;
}
/**
 * 
 * @export
 * @interface TeamTrigger
 */
export interface TeamTrigger {
    /**
     * 
     * @type {string}
     * @memberof TeamTrigger
     */
    kind: TeamTriggerKindEnum;
    /**
     * Id of the member that handles the first message
     * @type {string}
     * @memberof TeamTrigger
     */
    member: string;
}


/**
 * @export
 */
export const TeamTriggerKindEnum = {
    FirstMessage: 'first-message'
} as const;
export type TeamTriggerKindEnum = typeof TeamTriggerKindEnum[keyof typeof TeamTriggerKindEnum];

/**
 * 
 * @export
 * @interface TeamVersionRestoredDto
 */
export interface TeamVersionRestoredDto {
    /**
     * 
     * @type {string}
     * @memberof TeamVersionRestoredDto
     */
    slug: string;
    /**
     * the team version the library file now holds
     * @type {string}
     * @memberof TeamVersionRestoredDto
     */
    version: string;
    /**
     * the file hash the next save must quote
     * @type {string}
     * @memberof TeamVersionRestoredDto
     */
    hash: string;
    /**
     * where the replaced file was copied, relative to the library
     * @type {string}
     * @memberof TeamVersionRestoredDto
     */
    backup: string;
}
/**
 * 
 * @export
 * @interface TeamVersionRow
 */
export interface TeamVersionRow {
    /**
     * 
     * @type {string}
     * @memberof TeamVersionRow
     */
    version: string | null;
    /**
     * 
     * @type {number}
     * @memberof TeamVersionRow
     */
    ordinal: number | null;
    /**
     * every run of it predates team copies, so the team was frozen after the run started
     * @type {boolean}
     * @memberof TeamVersionRow
     */
    inferred: boolean;
    /**
     * false only for the library team before its first run or restore records it
     * @type {boolean}
     * @memberof TeamVersionRow
     */
    recorded: boolean;
    /**
     * recorded while teams were node graphs; its diff is taken over the graph converted to a team
     * @type {boolean}
     * @memberof TeamVersionRow
     */
    preTeam: boolean;
    /**
     * 
     * @type {string}
     * @memberof TeamVersionRow
     */
    firstRunAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof TeamVersionRow
     */
    lastRunAt: string | null;
    /**
     * 
     * @type {VersionChanges}
     * @memberof TeamVersionRow
     */
    changes: VersionChanges | null;
    /**
     * 
     * @type {VersionFigures}
     * @memberof TeamVersionRow
     */
    figures: VersionFigures;
}
/**
 * 
 * @export
 * @interface TeamVersionRunFigures
 */
export interface TeamVersionRunFigures {
    /**
     * 
     * @type {number}
     * @memberof TeamVersionRunFigures
     */
    runs: number;
    /**
     * 
     * @type {number}
     * @memberof TeamVersionRunFigures
     */
    costPerRunUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof TeamVersionRunFigures
     */
    workedPerRunMs: number | null;
}
/**
 * 
 * @export
 * @interface TeamVersionsDto
 */
export interface TeamVersionsDto {
    /**
     * 
     * @type {string}
     * @memberof TeamVersionsDto
     */
    slug: string;
    /**
     * 
     * @type {string}
     * @memberof TeamVersionsDto
     */
    currentVersion: string | null;
    /**
     * newest first
     * @type {Array<TeamVersionRow>}
     * @memberof TeamVersionsDto
     */
    versions: Array<TeamVersionRow>;
    /**
     * 
     * @type {TeamVersionRow}
     * @memberof TeamVersionsDto
     */
    unversioned: TeamVersionRow | null;
    /**
     * folded over every run of the team, not summed from the rows
     * @type {VersionFigures}
     * @memberof TeamVersionsDto
     */
    totals: VersionFigures;
}
/**
 * 
 * @export
 * @interface ThreadAnalysisDto
 */
export interface ThreadAnalysisDto {
    /**
     * 
     * @type {ThreadOverviewDtoAnalysisAnalysis}
     * @memberof ThreadAnalysisDto
     */
    analysis: ThreadOverviewDtoAnalysisAnalysis | null;
}
/**
 * 
 * @export
 * @interface ThreadLessonEstimateDto
 */
export interface ThreadLessonEstimateDto {
    /**
     * 
     * @type {LessonEstimate}
     * @memberof ThreadLessonEstimateDto
     */
    estimate: LessonEstimate;
    /**
     * 
     * @type {LessonEstimate}
     * @memberof ThreadLessonEstimateDto
     */
    check: LessonEstimate | null;
    /**
     * Learning signals past the last reflection; 0 = nothing worth reflecting on
     * @type {number}
     * @memberof ThreadLessonEstimateDto
     */
    signals: number;
    /**
     * 
     * @type {number}
     * @memberof ThreadLessonEstimateDto
     */
    fromSeq: number;
    /**
     * 
     * @type {number}
     * @memberof ThreadLessonEstimateDto
     */
    toSeq: number;
}
/**
 * 
 * @export
 * @interface ThreadLessonsStateDto
 */
export interface ThreadLessonsStateDto {
    /**
     * Something past the last reflection exists and the thread may be reflected on
     * @type {boolean}
     * @memberof ThreadLessonsStateDto
     */
    reflectable: boolean;
    /**
     * 
     * @type {string}
     * @memberof ThreadLessonsStateDto
     */
    reflectionRunId: string | null;
    /**
     * 
     * @type {number}
     * @memberof ThreadLessonsStateDto
     */
    reflectedThroughSeq: number | null;
}
/**
 * 
 * @export
 * @interface ThreadMetrics
 */
export interface ThreadMetrics {
    /**
     * 
     * @type {GoalFigures}
     * @memberof ThreadMetrics
     */
    goals: GoalFigures;
    /**
     * 
     * @type {ThreadOutcomeCounts}
     * @memberof ThreadMetrics
     */
    outcomes: ThreadOutcomeCounts;
    /**
     * 
     * @type {number}
     * @memberof ThreadMetrics
     */
    handOffs: number | null;
    /**
     * most called first
     * @type {Array<ToolUse>}
     * @memberof ThreadMetrics
     */
    tools: Array<ToolUse>;
    /**
     * most called first
     * @type {Array<McpServerUse>}
     * @memberof ThreadMetrics
     */
    mcpServers: Array<McpServerUse>;
    /**
     * 
     * @type {Array<StageFigures>}
     * @memberof ThreadMetrics
     */
    stages: Array<StageFigures>;
    /**
     * one row per caller and callee, most calls first
     * @type {Array<MemberCall>}
     * @memberof ThreadMetrics
     */
    calls: Array<MemberCall>;
}
/**
 * 
 * @export
 * @interface ThreadOutcome
 */
export interface ThreadOutcome {
    /**
     * 
     * @type {ThreadOutcomeKind}
     * @memberof ThreadOutcome
     */
    kind: ThreadOutcomeKind;
    /**
     * 
     * @type {string}
     * @memberof ThreadOutcome
     */
    summary: string | null;
    /**
     * recorded: an agent called record_outcome; goals: derived from how its goals closed
     * @type {string}
     * @memberof ThreadOutcome
     */
    source: ThreadOutcomeSourceEnum;
    /**
     * 
     * @type {number}
     * @memberof ThreadOutcome
     */
    seq: number | null;
}


/**
 * @export
 */
export const ThreadOutcomeSourceEnum = {
    Recorded: 'recorded',
    Goals: 'goals'
} as const;
export type ThreadOutcomeSourceEnum = typeof ThreadOutcomeSourceEnum[keyof typeof ThreadOutcomeSourceEnum];

/**
 * 
 * @export
 * @interface ThreadOutcomeCounts
 */
export interface ThreadOutcomeCounts {
    /**
     * 
     * @type {number}
     * @memberof ThreadOutcomeCounts
     */
    success: number;
    /**
     * 
     * @type {number}
     * @memberof ThreadOutcomeCounts
     */
    partial: number;
    /**
     * 
     * @type {number}
     * @memberof ThreadOutcomeCounts
     */
    failed: number;
    /**
     * 
     * @type {number}
     * @memberof ThreadOutcomeCounts
     */
    abandoned: number;
    /**
     * runs whose outcome an agent recorded
     * @type {number}
     * @memberof ThreadOutcomeCounts
     */
    recorded: number;
    /**
     * runs whose outcome is read from their goals
     * @type {number}
     * @memberof ThreadOutcomeCounts
     */
    derived: number;
}

/**
 * 
 * @export
 */
export const ThreadOutcomeKind = {
    Success: 'success',
    Partial: 'partial',
    Failed: 'failed',
    Abandoned: 'abandoned'
} as const;
export type ThreadOutcomeKind = typeof ThreadOutcomeKind[keyof typeof ThreadOutcomeKind];

/**
 * 
 * @export
 * @interface ThreadOverviewDto
 */
export interface ThreadOverviewDto {
    /**
     * 
     * @type {ThreadOverviewDtoState}
     * @memberof ThreadOverviewDto
     */
    state: ThreadOverviewDtoState | null;
    /**
     * 
     * @type {ThreadOverviewDtoTotals}
     * @memberof ThreadOverviewDto
     */
    totals: ThreadOverviewDtoTotals | null;
    /**
     * 
     * @type {ThreadOverviewDtoTimeline}
     * @memberof ThreadOverviewDto
     */
    timeline: ThreadOverviewDtoTimeline | null;
    /**
     * 
     * @type {ThreadOverviewDtoArtifacts}
     * @memberof ThreadOverviewDto
     */
    artifacts: ThreadOverviewDtoArtifacts | null;
    /**
     * 
     * @type {ThreadOverviewDtoAnalysis}
     * @memberof ThreadOverviewDto
     */
    analysis: ThreadOverviewDtoAnalysis | null;
}
/**
 * 
 * @export
 * @interface ThreadOverviewDtoAnalysis
 */
export interface ThreadOverviewDtoAnalysis {
    /**
     * 
     * @type {ThreadOverviewDtoAnalysisAnalysis}
     * @memberof ThreadOverviewDtoAnalysis
     */
    analysis: ThreadOverviewDtoAnalysisAnalysis | null;
}
/**
 * 
 * @export
 * @interface ThreadOverviewDtoAnalysisAnalysis
 */
export interface ThreadOverviewDtoAnalysisAnalysis {
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    id: string;
    /**
     * 
     * @type {RunStatus}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    status: RunStatus;
    /**
     * 
     * @type {RunAwaiting}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    awaiting: RunAwaiting | null;
    /**
     * Units of background work this run is being held for; 0 when the agent itself is working
     * @type {number}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    holdingFor: number;
    /**
     * Agents of this run waiting on their own calls; 0 when none is waiting
     * @type {number}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    awaitingCalls: number;
    /**
     * Trigger members of this team run inside a turn (calls excluded); 0 when a message would be taken now
     * @type {number}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    rootsWorking: number;
    /**
     * Detached commands this run still has running; 0 when none are out
     * @type {number}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    shellsOpen: number;
    /**
     * Background sub-agents this run still has out; 0 when none are out
     * @type {number}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    subagentsOut: number;
    /**
     * Monitors this run has running; 0 when none are
     * @type {number}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    monitorsOpen: number;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    title: string | null;
    /**
     * 
     * @type {AgentKind}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    agentKind: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    teamId: string | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    cwd: string | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    startSha: string | null;
    /**
     * 
     * @type {boolean}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    startDirty: boolean | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    model: string | null;
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    approval: ChatApprovalMode | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    effort: string | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    contextWindow: string | null;
    /**
     * 
     * @type {number}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    autoCompactPercent: number | null;
    /**
     * Every OTHER model setting this run's next turn asks for, keyed by the CLI's own parameter id; {} when none are set. Sent back verbatim — geniro holds no vocabulary for these
     * @type {{ [key: string]: string; }}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    modelParameters: { [key: string]: string; };
    /**
     * 
     * @type {number}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    contextTokens: number | null;
    /**
     * Whether contextTokens is geniro's stand-in for an occupancy the CLI did not state; false when the CLI stated it
     * @type {boolean}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    contextEstimated: boolean;
    /**
     * 
     * @type {number}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    contextWindowTokens: number | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    configDir: string | null;
    /**
     * 
     * @type {ConfigDirPin}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    configDirPin: ConfigDirPin | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    groupId: string | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    taskId: string | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    taskIdentifier: string | null;
    /**
     * 
     * @type {RunProjectRef}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    project: RunProjectRef | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    analysisSourceRunId: string | null;
    /**
     * 
     * @type {number}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    analysisSourceSeq: number | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    analysisTeamSlug: string | null;
    /**
     * 
     * @type {number}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    pinnedPosition: number | null;
    /**
     * 
     * @type {RunGroupColor}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    color: RunGroupColor | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    createdAt: string;
    /**
     * The run's last-activity time
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    updatedAt: string;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    lastMessage: string | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    lastActivityAt: string | null;
    /**
     * Pull requests this run opened, as captured from the agent output, and those its CLI recorded it touching; oldest first
     * @type {Array<DisplayedPullRequest>}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    pullRequests: Array<DisplayedPullRequest>;
    /**
     * Calls a usage limit stopped that geniro continues when the window reopens
     * @type {Array<RunResetWake>}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    resetWakes: Array<RunResetWake>;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    archivedAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    attentionAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    seenAt: string | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    notes: string | null;
    /**
     * Each agent's own task list as it stands now, folded from the whole transcript
     * @type {Array<RunTaskGroup>}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    taskList: Array<RunTaskGroup>;
    /**
     * 
     * @type {StageProgress}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    stages: StageProgress | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    currentLead: string | null;
    /**
     * The run's goals as the goals tool and the user left them, open and closed
     * @type {Array<RunGoal>}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    goals: Array<RunGoal>;
    /**
     * 
     * @type {ThreadOutcome}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    outcome: ThreadOutcome | null;
    /**
     * 
     * @type {number}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    workedMs: number | null;
    /**
     * 
     * @type {number}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    toolCalls: number | null;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    promptCacheExpiresAt: string | null;
    /**
     * 
     * @type {number}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    promptCacheTtlMs: number | null;
    /**
     * 
     * @type {PromptCacheTtlReason}
     * @memberof ThreadOverviewDtoAnalysisAnalysis
     */
    promptCacheTtlReason: PromptCacheTtlReason | null;
}


/**
 * 
 * @export
 * @interface ThreadOverviewDtoArtifacts
 */
export interface ThreadOverviewDtoArtifacts {
    /**
     * 
     * @type {Array<RunArtifact>}
     * @memberof ThreadOverviewDtoArtifacts
     */
    artifacts: Array<RunArtifact>;
}
/**
 * 
 * @export
 * @interface ThreadOverviewDtoState
 */
export interface ThreadOverviewDtoState {
    /**
     * the approval and question cards still waiting for an answer, oldest first
     * @type {Array<ChatHistoryDtoItemsInner>}
     * @memberof ThreadOverviewDtoState
     */
    openRequests: Array<ChatHistoryDtoItemsInner>;
    /**
     * every call, in start order
     * @type {Array<RunCallState>}
     * @memberof ThreadOverviewDtoState
     */
    calls: Array<RunCallState>;
    /**
     * every delegate, in launch order
     * @type {Array<RunDelegateState>}
     * @memberof ThreadOverviewDtoState
     */
    delegates: Array<RunDelegateState>;
    /**
     * each dynamic workflow's launching call and reply, and its first and newest announcement
     * @type {Array<ChatHistoryDtoItemsInner>}
     * @memberof ThreadOverviewDtoState
     */
    workflowRows: Array<ChatHistoryDtoItemsInner>;
    /**
     * every artifact-tool call and its reply
     * @type {Array<ChatHistoryDtoItemsInner>}
     * @memberof ThreadOverviewDtoState
     */
    artifactRows: Array<ChatHistoryDtoItemsInner>;
    /**
     * every DETACHED command still running
     * @type {Array<OpenShell>}
     * @memberof ThreadOverviewDtoState
     */
    shells: Array<OpenShell>;
    /**
     * every conversation's monitors still running, in start order
     * @type {Array<OpenMonitor>}
     * @memberof ThreadOverviewDtoState
     */
    monitors: Array<OpenMonitor>;
    /**
     * the buttons agents published that can still be pressed, newest first
     * @type {Array<LiveAction>}
     * @memberof ThreadOverviewDtoState
     */
    actions: Array<LiveAction>;
    /**
     * the unanswered tool calls of every conversation's open turn — the commands running in the foreground, whatever page a client holds
     * @type {Array<ChatHistoryDtoItemsInner>}
     * @memberof ThreadOverviewDtoState
     */
    openToolCalls: Array<ChatHistoryDtoItemsInner>;
    /**
     * the run's newest seq when this was read: what it says ended, ended — for anything that started at or before it
     * @type {number}
     * @memberof ThreadOverviewDtoState
     */
    throughSeq: number;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoState
     */
    turnStartedAt: string | null;
    /**
     * a 1:1 chat's open turn: how long the holds that have ended kept it waiting on background work it launched
     * @type {number}
     * @memberof ThreadOverviewDtoState
     */
    turnHeldMs: number;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoState
     */
    turnHeldSince: string | null;
}
/**
 * 
 * @export
 * @interface ThreadOverviewDtoTimeline
 */
export interface ThreadOverviewDtoTimeline {
    /**
     * 
     * @type {Array<ChatTimelineMarker>}
     * @memberof ThreadOverviewDtoTimeline
     */
    markers: Array<ChatTimelineMarker>;
    /**
     * 
     * @type {string}
     * @memberof ThreadOverviewDtoTimeline
     */
    partialReason: string | null;
}
/**
 * 
 * @export
 * @interface ThreadOverviewDtoTotals
 */
export interface ThreadOverviewDtoTotals {
    /**
     * 
     * @type {ChatTotals}
     * @memberof ThreadOverviewDtoTotals
     */
    totals: ChatTotals;
    /**
     * on a TEAM run, the merged wall-clock stretches in which some agent of it was working, with every `pausedSpans` stretch already cut out — a CLOCK reads their union, where `totals.workedMs` is a sum that runs N times faster while N agents work at once. Always empty for a chat, whose header draws its own clock
     * @type {Array<ActiveSpan>}
     * @memberof ThreadOverviewDtoTotals
     */
    activeSpans: Array<ActiveSpan>;
    /**
     * on a TEAM run, where it waited on the user — an approval or question card open with no background shell or sub-agent running. The header clock stands still through them, the open one included. Always empty for a chat
     * @type {Array<PausedSpan>}
     * @memberof ThreadOverviewDtoTotals
     */
    pausedSpans: Array<PausedSpan>;
}
/**
 * 
 * @export
 * @interface ToolUse
 */
export interface ToolUse {
    /**
     * 
     * @type {string}
     * @memberof ToolUse
     */
    tool: string;
    /**
     * 
     * @type {string}
     * @memberof ToolUse
     */
    mcpServer: string | null;
    /**
     * 
     * @type {number}
     * @memberof ToolUse
     */
    calls: number;
    /**
     * 
     * @type {number}
     * @memberof ToolUse
     */
    errors: number;
    /**
     * 
     * @type {number}
     * @memberof ToolUse
     */
    avgMs: number | null;
}
/**
 * 
 * @export
 * @interface UiLogDto
 */
export interface UiLogDto {
    /**
     * 
     * @type {DebugLevel}
     * @memberof UiLogDto
     */
    level: DebugLevel;
    /**
     * 
     * @type {string}
     * @memberof UiLogDto
     */
    message: string;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof UiLogDto
     */
    context?: { [key: string]: string; } | null;
}


/**
 * 
 * @export
 * @interface UpdateChatSettingsDto
 */
export interface UpdateChatSettingsDto {
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof UpdateChatSettingsDto
     */
    approval?: ChatApprovalMode;
    /**
     * 
     * @type {string}
     * @memberof UpdateChatSettingsDto
     */
    model?: string | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateChatSettingsDto
     */
    effort?: string | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateChatSettingsDto
     */
    contextWindow?: string | null;
    /**
     * 
     * @type {number}
     * @memberof UpdateChatSettingsDto
     */
    autoCompactPercent?: number | null;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof UpdateChatSettingsDto
     */
    modelParameters?: { [key: string]: string; } | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateChatSettingsDto
     */
    configDir?: string | null;
}


/**
 * 
 * @export
 * @interface UpdateKnowledgeDto
 */
export interface UpdateKnowledgeDto {
    /**
     * 
     * @type {string}
     * @memberof UpdateKnowledgeDto
     */
    title: string;
    /**
     * 
     * @type {string}
     * @memberof UpdateKnowledgeDto
     */
    whenToRead: string;
    /**
     * 
     * @type {string}
     * @memberof UpdateKnowledgeDto
     */
    body: string;
    /**
     * 
     * @type {string}
     * @memberof UpdateKnowledgeDto
     */
    handle?: string;
    /**
     * 
     * @type {number}
     * @memberof UpdateKnowledgeDto
     */
    rev: number;
}
/**
 * 
 * @export
 * @interface UpdateLabelInstructionDto
 */
export interface UpdateLabelInstructionDto {
    /**
     * 
     * @type {string}
     * @memberof UpdateLabelInstructionDto
     */
    label?: string;
    /**
     * 
     * @type {string}
     * @memberof UpdateLabelInstructionDto
     */
    projectId?: string | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateLabelInstructionDto
     */
    instructions?: string;
}
/**
 * 
 * @export
 * @interface UpdateLessonRuleDto
 */
export interface UpdateLessonRuleDto {
    /**
     * 
     * @type {string}
     * @memberof UpdateLessonRuleDto
     */
    title?: string;
    /**
     * 
     * @type {string}
     * @memberof UpdateLessonRuleDto
     */
    rule?: string;
}
/**
 * 
 * @export
 * @interface UpdateMemoryDto
 */
export interface UpdateMemoryDto {
    /**
     * 
     * @type {string}
     * @memberof UpdateMemoryDto
     */
    status?: UpdateMemoryDtoStatusEnum;
    /**
     * 
     * @type {number}
     * @memberof UpdateMemoryDto
     */
    rev?: number;
    /**
     * 
     * @type {string}
     * @memberof UpdateMemoryDto
     */
    title?: string;
    /**
     * 
     * @type {string}
     * @memberof UpdateMemoryDto
     */
    body?: string;
    /**
     * 
     * @type {string}
     * @memberof UpdateMemoryDto
     */
    type?: UpdateMemoryDtoTypeEnum;
    /**
     * 
     * @type {string}
     * @memberof UpdateMemoryDto
     */
    projectId?: string | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateMemoryDto
     */
    teamSlug?: string | null;
    /**
     * 
     * @type {Array<string>}
     * @memberof UpdateMemoryDto
     */
    notDuplicateOf?: Array<string>;
}


/**
 * @export
 */
export const UpdateMemoryDtoStatusEnum = {
    Active: 'active',
    Forgotten: 'forgotten'
} as const;
export type UpdateMemoryDtoStatusEnum = typeof UpdateMemoryDtoStatusEnum[keyof typeof UpdateMemoryDtoStatusEnum];

/**
 * @export
 */
export const UpdateMemoryDtoTypeEnum = {
    User: 'user',
    Feedback: 'feedback',
    Project: 'project',
    Reference: 'reference'
} as const;
export type UpdateMemoryDtoTypeEnum = typeof UpdateMemoryDtoTypeEnum[keyof typeof UpdateMemoryDtoTypeEnum];

/**
 * 
 * @export
 * @interface UpdateProjectDto
 */
export interface UpdateProjectDto {
    /**
     * 
     * @type {string}
     * @memberof UpdateProjectDto
     */
    name?: string;
    /**
     * 
     * @type {string}
     * @memberof UpdateProjectDto
     */
    folder?: string;
    /**
     * 
     * @type {string}
     * @memberof UpdateProjectDto
     */
    groupId?: string | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateProjectDto
     */
    description?: string | null;
    /**
     * 
     * @type {Array<ProjectInstructionBlock>}
     * @memberof UpdateProjectDto
     */
    instructionBlocks?: Array<ProjectInstructionBlock> | null;
    /**
     * 
     * @type {AgentKind}
     * @memberof UpdateProjectDto
     */
    agentKind?: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateProjectDto
     */
    model?: string | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateProjectDto
     */
    effort?: string | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateProjectDto
     */
    contextWindow?: string | null;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof UpdateProjectDto
     */
    modelParameters?: { [key: string]: string; } | null;
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof UpdateProjectDto
     */
    approval?: ChatApprovalMode | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateProjectDto
     */
    configDir?: string | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateProjectDto
     */
    teamSlug?: string | null;
    /**
     * 
     * @type {LessonOverride}
     * @memberof UpdateProjectDto
     */
    lessons?: LessonOverride | null;
    /**
     * 
     * @type {boolean}
     * @memberof UpdateProjectDto
     */
    autopilotEnabled?: boolean;
    /**
     * 
     * @type {TaskStatus}
     * @memberof UpdateProjectDto
     */
    autopilotIntakeStatus?: TaskStatus;
    /**
     * 
     * @type {number}
     * @memberof UpdateProjectDto
     */
    autopilotMaxConcurrent?: number;
    /**
     * 
     * @type {number}
     * @memberof UpdateProjectDto
     */
    expectedInstructionsRevision?: number;
}


/**
 * 
 * @export
 * @interface UpdateRunGroupDto
 */
export interface UpdateRunGroupDto {
    /**
     * 
     * @type {string}
     * @memberof UpdateRunGroupDto
     */
    name?: string;
    /**
     * 
     * @type {RunGroupColor}
     * @memberof UpdateRunGroupDto
     */
    color?: RunGroupColor;
    /**
     * 
     * @type {boolean}
     * @memberof UpdateRunGroupDto
     */
    collapsed?: boolean;
    /**
     * 
     * @type {string}
     * @memberof UpdateRunGroupDto
     */
    autoCwd?: string | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateRunGroupDto
     */
    autoTeamId?: string | null;
}


/**
 * 
 * @export
 * @interface UpdateTaskDto
 */
export interface UpdateTaskDto {
    /**
     * 
     * @type {string}
     * @memberof UpdateTaskDto
     */
    title?: string;
    /**
     * 
     * @type {string}
     * @memberof UpdateTaskDto
     */
    description?: string | null;
    /**
     * 
     * @type {Array<string>}
     * @memberof UpdateTaskDto
     */
    labels?: Array<string>;
    /**
     * 
     * @type {TaskPriority}
     * @memberof UpdateTaskDto
     */
    priority?: TaskPriority;
    /**
     * 
     * @type {string}
     * @memberof UpdateTaskDto
     */
    dueDate?: string | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateTaskDto
     */
    folder?: string | null;
    /**
     * 
     * @type {AgentKind}
     * @memberof UpdateTaskDto
     */
    agentKind?: AgentKind | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateTaskDto
     */
    model?: string | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateTaskDto
     */
    effort?: string | null;
    /**
     * 
     * @type {{ [key: string]: string; }}
     * @memberof UpdateTaskDto
     */
    modelParameters?: { [key: string]: string; } | null;
    /**
     * 
     * @type {ChatApprovalMode}
     * @memberof UpdateTaskDto
     */
    approval?: ChatApprovalMode | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateTaskDto
     */
    configDir?: string | null;
    /**
     * 
     * @type {string}
     * @memberof UpdateTaskDto
     */
    teamSlug?: string | null;
}


/**
 * 
 * @export
 * @interface UploadChatFileDto
 */
export interface UploadChatFileDto {
    /**
     * The file’s own name, which is what the agent sees in the path
     * @type {string}
     * @memberof UploadChatFileDto
     */
    name: string;
    /**
     * The file’s bytes, base64-encoded
     * @type {string}
     * @memberof UploadChatFileDto
     */
    data: string;
}
/**
 * 
 * @export
 * @interface UploadTaskFileDto
 */
export interface UploadTaskFileDto {
    /**
     * The file’s own name, which is what the card lists
     * @type {string}
     * @memberof UploadTaskFileDto
     */
    name: string;
    /**
     * The file’s bytes, base64-encoded
     * @type {string}
     * @memberof UploadTaskFileDto
     */
    data: string;
}
/**
 * 
 * @export
 * @interface UploadTeamAvatarDto
 */
export interface UploadTeamAvatarDto {
    /**
     * The picture’s bytes, base64-encoded
     * @type {string}
     * @memberof UploadTeamAvatarDto
     */
    data: string;
}
/**
 * 
 * @export
 * @interface UsageBucket
 */
export interface UsageBucket {
    /**
     * calendar day, YYYY-MM-DD, in local time
     * @type {string}
     * @memberof UsageBucket
     */
    date: string;
    /**
     * 
     * @type {ChatTotals}
     * @memberof UsageBucket
     */
    totals: ChatTotals;
    /**
     * what the threads did that day — see ActivityTotals
     * @type {ActivityTotals}
     * @memberof UsageBucket
     */
    activity: ActivityTotals;
}
/**
 * 
 * @export
 * @interface UsageGroup
 */
export interface UsageGroup {
    /**
     * 
     * @type {string}
     * @memberof UsageGroup
     */
    key: string | null;
    /**
     * 
     * @type {ChatTotals}
     * @memberof UsageGroup
     */
    totals: ChatTotals;
    /**
     * 
     * @type {string}
     * @memberof UsageGroup
     */
    title?: string | null;
    /**
     * a thread that no longer exists — its spend outlives it
     * @type {boolean}
     * @memberof UsageGroup
     */
    deleted?: boolean;
}
/**
 * 
 * @export
 * @interface UsageStatsDto
 */
export interface UsageStatsDto {
    /**
     * ISO-8601, inclusive
     * @type {string}
     * @memberof UsageStatsDto
     */
    from: string;
    /**
     * ISO-8601, exclusive
     * @type {string}
     * @memberof UsageStatsDto
     */
    to: string;
    /**
     * 
     * @type {ChatTotals}
     * @memberof UsageStatsDto
     */
    totals: ChatTotals;
    /**
     * what the threads did over the period — the same figures the days sum to
     * @type {ActivityTotals}
     * @memberof UsageStatsDto
     */
    activity: ActivityTotals;
    /**
     * every day in the range, including days with no activity
     * @type {Array<UsageBucket>}
     * @memberof UsageStatsDto
     */
    days: Array<UsageBucket>;
    /**
     * 
     * @type {Array<UsageGroup>}
     * @memberof UsageStatsDto
     */
    byAgent: Array<UsageGroup>;
    /**
     * 
     * @type {Array<UsageGroup>}
     * @memberof UsageStatsDto
     */
    byModel: Array<UsageGroup>;
    /**
     * per project folder; a git worktree is filed under its repository
     * @type {Array<UsageGroup>}
     * @memberof UsageStatsDto
     */
    byProject: Array<UsageGroup>;
    /**
     * per thread (run), keyed by run id — chats and team runs
     * @type {Array<UsageGroup>}
     * @memberof UsageStatsDto
     */
    byThread: Array<UsageGroup>;
    /**
     * per team, keyed by slug; a thread with no team is in no row, so a chat is never pooled into one
     * @type {Array<UsageGroup>}
     * @memberof UsageStatsDto
     */
    byTeam: Array<UsageGroup>;
    /**
     * spend the app made for itself, keyed by purpose: `lessons` is the hidden lessons reflections; the user's own work is in no row
     * @type {Array<UsageGroup>}
     * @memberof UsageStatsDto
     */
    byPurpose: Array<UsageGroup>;
    /**
     * the threads started in the period: goals, outcomes, and every tool and MCP server called in it
     * @type {ThreadMetrics}
     * @memberof UsageStatsDto
     */
    metrics: ThreadMetrics;
}
/**
 * 
 * @export
 * @interface VersionChanges
 */
export interface VersionChanges {
    /**
     * lines the diff adds
     * @type {number}
     * @memberof VersionChanges
     */
    added: number;
    /**
     * lines the diff removes
     * @type {number}
     * @memberof VersionChanges
     */
    removed: number;
    /**
     * unified diff of the two graphs' YAML; empty when they match
     * @type {string}
     * @memberof VersionChanges
     */
    diff: string;
}
/**
 * 
 * @export
 * @interface VersionFigures
 */
export interface VersionFigures {
    /**
     * 
     * @type {number}
     * @memberof VersionFigures
     */
    runs: number;
    /**
     * 
     * @type {number}
     * @memberof VersionFigures
     */
    costUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof VersionFigures
     */
    avgCostUsd: number | null;
    /**
     * 
     * @type {number}
     * @memberof VersionFigures
     */
    estimatedCostUsd: number | null;
}
/**
 * 
 * @export
 * @interface WaitingMessageDto
 */
export interface WaitingMessageDto {
    /**
     * 
     * @type {string}
     * @memberof WaitingMessageDto
     */
    id: string;
    /**
     * 
     * @type {string}
     * @memberof WaitingMessageDto
     */
    fromRunId: string;
    /**
     * 
     * @type {string}
     * @memberof WaitingMessageDto
     */
    fromTitle: string;
    /**
     * 
     * @type {string}
     * @memberof WaitingMessageDto
     */
    fromMember: string | null;
    /**
     * 
     * @type {string}
     * @memberof WaitingMessageDto
     */
    text: string;
    /**
     * 
     * @type {string}
     * @memberof WaitingMessageDto
     */
    reason: WaitingMessageDtoReasonEnum | null;
    /**
     * 
     * @type {string}
     * @memberof WaitingMessageDto
     */
    createdAt: string;
}


/**
 * @export
 */
export const WaitingMessageDtoReasonEnum = {
    RunningTurn: 'running_turn',
    Stopped: 'stopped',
    Failed: 'failed',
    NotStarted: 'not_started',
    Question: 'question',
    SenderOptedOut: 'sender_opted_out',
    ColdAndLarge: 'cold_and_large',
    WakeLimit: 'wake_limit'
} as const;
export type WaitingMessageDtoReasonEnum = typeof WaitingMessageDtoReasonEnum[keyof typeof WaitingMessageDtoReasonEnum];

/**
 * 
 * @export
 * @interface WriteMcpConfigDto
 */
export interface WriteMcpConfigDto {
    /**
     * 
     * @type {AgentKind}
     * @memberof WriteMcpConfigDto
     */
    agent: AgentKind;
    /**
     * 
     * @type {string}
     * @memberof WriteMcpConfigDto
     */
    configDir?: string;
    /**
     * 
     * @type {{ [key: string]: { [key: string]: any; }; }}
     * @memberof WriteMcpConfigDto
     */
    servers: { [key: string]: { [key: string]: any; }; };
    /**
     * 
     * @type {string}
     * @memberof WriteMcpConfigDto
     */
    version: string | null;
}


