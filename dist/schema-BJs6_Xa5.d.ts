type ActionStep = {
    action: "setStyle";
    selector: string;
    style: Record<string, string>;
} | {
    action: "addClass";
    selector: string;
    className: string;
} | {
    action: "removeClass";
    selector: string;
    className: string;
} | {
    action: "toggleClass";
    selector: string;
    className: string;
} | {
    action: "hideElement";
    selector: string;
} | {
    action: "showElement";
    selector: string;
} | {
    action: "removeElement";
    selector: string;
} | {
    action: "setText";
    selector: string;
    text: string;
} | {
    action: "setAttribute";
    selector: string;
    attr: string;
    value: string;
} | {
    action: "click";
    selector: string;
} | {
    action: "scrollTo";
    selector: string;
} | {
    action: "fill";
    selector: string;
    value: string;
} | {
    action: "queryText";
    selector: string;
    returnAs: string;
} | {
    action: "waitFor";
    selector: string;
    timeout?: number;
} | {
    action: "delay";
    ms: number;
};
declare const AVAILABLE_ACTIONS: readonly ["setStyle", "addClass", "removeClass", "toggleClass", "hideElement", "showElement", "removeElement", "setText", "setAttribute", "click", "scrollTo", "fill", "queryText", "waitFor", "delay"];
interface ActionResult {
    success: boolean;
    steps: Array<{
        action: string;
        selector?: string;
        ok: boolean;
        error?: string;
    }>;
    queryResults: Record<string, unknown>;
}

export { AVAILABLE_ACTIONS as A, type ActionResult as a, type ActionStep as b };
