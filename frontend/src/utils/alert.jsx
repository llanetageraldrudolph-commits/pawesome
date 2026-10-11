import Swal from "sweetalert2";

const lightTheme = {
  customClass: {
    popup: "swal2-light-popup",
    confirmButton: "swal2-light-confirm",
    cancelButton: "swal2-light-cancel",
    title: "swal2-light-title",
    htmlContainer: "swal2-light-text",
  },
  buttonsStyling: false,
  confirmButtonText: "OK",
  cancelButtonText: "Cancel",
  showCloseButton: true,
  allowOutsideClick: false,
  allowEscapeKey: true,
  backdrop: true,
  heightAuto: false,
};

export const showAlert = async (message, title = "") => {
  return Swal.fire({
    ...lightTheme,
    title,
    text: message,
    icon: "info",
    showCancelButton: false,
    confirmButtonText: "OK",
  });
};

export const showSuccess = async (message, title = "Success") => {
  return Swal.fire({
    ...lightTheme,
    title,
    text: message,
    icon: "success",
    showCancelButton: false,
    confirmButtonText: "OK",
  });
};

export const showError = async (message, title = "Error") => {
  return Swal.fire({
    ...lightTheme,
    title,
    text: message,
    icon: "error",
    showCancelButton: false,
    confirmButtonText: "OK",
  });
};

export const showWarning = async (message, title = "Warning") => {
  return Swal.fire({
    ...lightTheme,
    title,
    text: message,
    icon: "warning",
    showCancelButton: false,
    confirmButtonText: "OK",
  });
};

export const showConfirm = async (
  message,
  title = "",
  confirmText = "Yes",
  cancelText = "Cancel",
  icon = "question",
  danger = false
) => {
  const customClass = { ...lightTheme.customClass };
  if (danger) {
    customClass.confirmButton = "swal2-light-confirm swal2-light-confirm-danger";
  }
  const result = await Swal.fire({
    ...lightTheme,
    customClass,
    title,
    text: message,
    icon,
    showCancelButton: true,
    confirmButtonText: confirmText,
    cancelButtonText: cancelText,
    reverseButtons: true,
  });
  return result.isConfirmed;
};

export const showDeleteConfirm = async (
  itemName = "this item",
  message = `Are you sure you want to delete <strong>${itemName}</strong>? This action cannot be undone.`
) => {
  const result = await Swal.fire({
    ...lightTheme,
    title: "Delete Confirmation",
    html: message,
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "Delete",
    cancelButtonText: "Cancel",
    confirmButtonColor: "#dc3545",
    reverseButtons: true,
  });
  return result.isConfirmed;
};

export const showPrompt = async (
  message,
  title = "",
  defaultValue = "",
  confirmText = "OK",
  cancelText = "Cancel"
) => {
  const result = await Swal.fire({
    ...lightTheme,
    title,
    text: message,
    input: "text",
    inputValue: defaultValue,
    showCancelButton: true,
    confirmButtonText: confirmText,
    cancelButtonText: cancelText,
    reverseButtons: true,
  });
  if (result.isConfirmed) {
    return result.value;
  }
  return null;
};

// Preset reason lists shared by every cancel/reject prompt. The final entry
// is always "Other" which reveals a free-text field — the typed text is what
// gets returned, never the literal option label.
export const CUSTOMER_CANCEL_REASONS = [
  "Change of plans / schedule conflict",
  "Pet is sick or unavailable",
  "Booked the wrong date or time",
  "Duplicate or accidental booking",
  "Found another service provider",
  "Can no longer afford the service",
];

export const STAFF_CANCEL_REASONS = [
  "Requested by customer (phone / walk-in)",
  "Customer unreachable or did not confirm",
  "Double booking / schedule conflict",
  "No available room or time slot",
  "Staff unavailable on the scheduled date",
  "Pet failed health or temperament check",
];

export const BOOKING_REJECT_REASONS = [
  "Fully booked for the selected date/time",
  "Service not available for this pet type or breed",
  "Pet does not meet health/vaccination requirements",
  "Incomplete or invalid booking details",
  "Requested date is outside operating hours",
];

export const CANCEL_REJECT_REASONS = [
  "Cancellation deadline has passed",
  "Service already in progress",
  "Payment already processed",
];

export const PAYMENT_REJECT_REASONS = [
  "Invalid or unreadable payment proof",
  "Payment amount does not match the bill",
  "Wrong reference number or account",
  "Duplicate payment already submitted",
  "Payment not received / cannot be verified",
];

export const ORDER_REASONS = [
  "Item out of stock",
  "Requested by customer",
  "Payment not received or cannot be verified",
  "Duplicate or accidental order",
  "Order cannot be fulfilled",
];

export const showReasonPrompt = async (
  message,
  title = "Reason Required",
  confirmText = "Submit",
  reasonOptions = null
) => {
  const hasOptions = Array.isArray(reasonOptions) && reasonOptions.length > 0;
  const SELECT_ID = "swal-reason-select";
  const OTHER_ID = "swal-reason-other";
  const OTHER_VALUE = "__other__";

  const html = `${
    hasOptions
      ? `<select id="${SELECT_ID}" class="swal2-select" style="display:flex;width:85%;margin:0 auto 10px;">
          <option value="" disabled selected>Select a reason...</option>
          ${reasonOptions.map((o) => `<option value="${o.replace(/"/g, "&quot;")}">${o}</option>`).join("")}
          <option value="${OTHER_VALUE}">Other (please specify)</option>
        </select>`
      : ""
  }<textarea id="${OTHER_ID}" class="swal2-textarea" placeholder="${
    hasOptions ? "Please type your reason..." : "Enter reason..."
  }" style="width:85%;margin:0 auto;${hasOptions ? "display:none;" : ""}"></textarea>`;

  const result = await Swal.fire({
    ...lightTheme,
    title,
    text: message,
    html,
    focusConfirm: false,
    didOpen: () => {
      const sel = document.getElementById(SELECT_ID);
      const other = document.getElementById(OTHER_ID);
      sel?.addEventListener("change", () => {
        const isOther = sel.value === OTHER_VALUE;
        other.style.display = isOther ? "block" : "none";
        if (isOther) other.focus();
      });
    },
    preConfirm: () => {
      const sel = document.getElementById(SELECT_ID);
      const other = document.getElementById(OTHER_ID);
      if (sel && sel.value !== OTHER_VALUE) {
        if (!sel.value) {
          Swal.showValidationMessage("Please select a reason.");
          return false;
        }
        return sel.value;
      }
      const typed = other?.value?.trim() ?? "";
      if (!typed) {
        Swal.showValidationMessage("A reason is required.");
        return false;
      }
      return typed;
    },
    showCancelButton: true,
    confirmButtonText: confirmText,
    cancelButtonText: "Cancel",
    reverseButtons: true,
  });
  if (result.isConfirmed) {
    return result.value.trim();
  }
  return null;
};
