import { ethers } from "ethers";
export var TaskState;
(function (TaskState) {
    TaskState[TaskState["NONE"] = 0] = "NONE";
    TaskState[TaskState["CREATED"] = 1] = "CREATED";
    TaskState[TaskState["ACCEPTED"] = 2] = "ACCEPTED";
    TaskState[TaskState["SUBMITTED"] = 3] = "SUBMITTED";
    TaskState[TaskState["QUORUM_APPROVED"] = 4] = "QUORUM_APPROVED";
    TaskState[TaskState["REJECTED"] = 5] = "REJECTED";
    TaskState[TaskState["FINALIZED"] = 6] = "FINALIZED";
    TaskState[TaskState["TIMEOUT_REFUNDED"] = 7] = "TIMEOUT_REFUNDED";
    TaskState[TaskState["DISPUTED"] = 8] = "DISPUTED";
    TaskState[TaskState["RESOLVED"] = 9] = "RESOLVED";
})(TaskState || (TaskState = {}));
//# sourceMappingURL=types.js.map