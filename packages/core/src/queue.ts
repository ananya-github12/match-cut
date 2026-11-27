/** BullMQ queue shared by the API (producer) and the worker (consumer). */
export const BRIEF_QUEUE = "briefs";
/** Playbook jobs: long (up to 10 videos watched), so they don't queue behind or block briefs. */
export const PLAYBOOK_QUEUE = "playbooks";
