import React, { useEffect, useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBed,
  faCalendarAlt,
  faCalendarCheck,
  faCheckCircle,
  faClock,
  faCut,
  faDownload,
  faEye,
  faFilter,
  faHotel,
  faInfoCircle,
  faMoneyBillWave,
  faPaw,
  faPlus,
  faRefresh,
  faSearch,
  faSignOutAlt,
  faSpinner,
  faStethoscope,
  faTimes,
  faTimesCircle,
  faUndoAlt,
  faUser,
  faWrench,
} from "@fortawesome/free-solid-svg-icons";
import { apiRequest, getAuthenticatedFileUrl } from "../../api/client";
import { showConfirm, showReasonPrompt, BOOKING_REJECT_REASONS } from "../../utils/alert.jsx";
import { exportToCSV, exportToPDF, exportToExcel } from "../../utils/reportExport";
import { useUnifiedRequests } from "./hooks/useUnifiedRequests";
import RowActionPopover from "../shared/RowActionPopover";
import NewWalkInBookingModal from "./modals/NewWalkInBookingModal";
import ServiceManagerModal from "./ServiceManagerModal";
import {
  formatDate,
  formatTime,
  formatStatus,
  formatCurrency,
} from "./utils/requestNormalization";
import "../../styles/bookingModal.css";
import "./ReceptionistAppointmentsBoarding.css";

const STATUS_OPTIONS = [
  { value: "all", label: "All Status" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "in_progress", label: "In Progress" },
  { value: "checked_in", label: "Checked In" },
  { value: "completed", label: "Completed" },
  { value: "rejected", label: "Rejected / Cancelled" },
];

const TYPE_OPTIONS = [
  { value: "all", label: "All Types" },
  { value: "vet", label: "Veterinary" },
  { value: "hotel", label: "Hotel / Boarding" },
  { value: "grooming", label: "Grooming" },
];

const PAYMENT_OPTIONS = [
  { value: "all", label: "All Payments" },
  { value: "paid", label: "Paid" },
  { value: "partial", label: "Partial" },
  { value: "pending", label: "Pending" },
  { value: "unpaid", label: "Unpaid" },
];

const safeText = (value) => String(value || "").toLowerCase();

const TypeIcon = ({ type }) => {
  if (type === "grooming") return <FontAwesomeIcon icon={faCut} />;
  if (type === "hotel") return <FontAwesomeIcon icon={faHotel} />;
  if (type === "vet") return <FontAwesomeIcon icon={faStethoscope} />;
  return <FontAwesomeIcon icon={faPaw} />;
};

const TypeLabel = ({ type }) => {
  if (type === "grooming") return "Grooming";
  if (type === "hotel") return "Hotel";
  if (type === "vet") return "Veterinary";
  return "Service";
};

const StatusBadge = ({ status }) => {
  const classMap = {
    pending: "status-pending",
    approved: "status-approved",
    in_progress: "status-in-progress",
    checked_in: "status-checked-in",
    completed: "status-completed",
    checked_out: "status-completed",
    rejected: "status-rejected",
    cancelled: "status-rejected",
  };
  return <span className={`hub-status-badge ${classMap[status] || ""}`}>{formatStatus(status)}</span>;
};

const PaymentBadge = ({ status }) => {
  const classMap = {
    paid: "payment-paid",
    partial: "payment-partial",
    pending: "payment-pending",
    unpaid: "payment-unpaid",
  };
  return <span className={`hub-payment-badge ${classMap[status] || ""}`}>{status}</span>;
};

const StatCard = ({ icon, label, value, tone, active, onClick }) => (
  <button type="button" className={`hub-stat-card ${active ? "active" : ""} ${tone || ""}`} onClick={onClick}>
    <span className="hub-stat-icon">{icon}</span>
    <div>
      <h3>{value}</h3>
      <p>{label}</p>
    </div>
  </button>
);

const ReceptionistAppointmentsBoarding = () => {
  const { requests, setRequests, loading, refreshing, error, success, lastUpdated, stats, fetchAll, updateItemStatus, notify } =
    useUnifiedRequests();

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [paymentFilter, setPaymentFilter] = useState("all");

  const [selectedRequest, setSelectedRequest] = useState(null);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showBookingModal, setShowBookingModal] = useState(false);
  const [showServiceManager, setShowServiceManager] = useState(false);
  const [busyAction, setBusyAction] = useState("");

  const [veterinarians, setVeterinarians] = useState([]);
  const [vetAssignments, setVetAssignments] = useState({});

  const [showExportDropdown, setShowExportDropdown] = useState(false);

  // Fetch veterinarians for vet assignment
  useEffect(() => {
    const fetchVets = async () => {
      try {
        const result = await apiRequest("/receptionist/veterinarians/available", { method: "GET" });
        const list = Array.isArray(result) ? result : result?.data || result?.veterinarians || [];
        setVeterinarians(Array.isArray(list) ? list : []);
      } catch {
        setVeterinarians([]);
      }
    };
    fetchVets();
  }, []);

  const filteredRequests = useMemo(() => {
    const keyword = safeText(searchTerm);
    return requests.filter((item) => {
      const matchesSearch =
        !keyword ||
        safeText(item.id).includes(keyword) ||
        safeText(item.petName).includes(keyword) ||
        safeText(item.customerName).includes(keyword) ||
        safeText(item.service).includes(keyword) ||
        safeText(item.type).includes(keyword) ||
        safeText(item.status).includes(keyword) ||
        safeText(item.paymentStatus).includes(keyword) ||
        safeText(item.customerPhone).includes(keyword);

      const matchesStatus = statusFilter === "all" || item.status === statusFilter;
      const matchesType = typeFilter === "all" || item.type === typeFilter;
      const matchesPayment = paymentFilter === "all" || item.paymentStatus === paymentFilter;

      return matchesSearch && matchesStatus && matchesType && matchesPayment;
    });
  }, [requests, searchTerm, statusFilter, typeFilter, paymentFilter]);

  const sortedRequests = useMemo(() => {
    return [...filteredRequests].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [filteredRequests]);

  const clearFilters = () => {
    setSearchTerm("");
    setStatusFilter("all");
    setTypeFilter("all");
    setPaymentFilter("all");
  };

  const exportColumns = [
    { key: "id", label: "ID" },
    { key: "type", label: "Type" },
    { key: "petName", label: "Pet" },
    { key: "customerName", label: "Customer" },
    { key: "service", label: "Service" },
    { key: "date", label: "Date" },
    { key: "time", label: "Time" },
    { key: "status", label: "Status" },
    { key: "paymentStatus", label: "Payment" },
    { key: "amount", label: "Amount" },
    { key: "notes", label: "Notes" },
  ];

  const handleExport = (format) => {
    setShowExportDropdown(false);
    if (sortedRequests.length === 0) {
      notify("error", "No records to export.");
      return;
    }

    const exportData = sortedRequests.map((item) => ({
      ...item,
      date: formatDate(item.date),
      time: formatTime(item.time),
    }));

    const filename = "appointments-boarding";
    if (format === "csv") exportToCSV(exportData, exportColumns, filename);
    else if (format === "excel") exportToExcel(exportData, exportColumns, filename);
    else if (format === "pdf") exportToPDF(exportData, exportColumns, "Appointments & Boarding", filename);

    notify("success", "Export downloaded.");
  };

  const isBusy = (id, action) => busyAction === `${id}-${action}`;

  const openVaccinationCard = async (cardUrl) => {
    if (!cardUrl) return;
    const win = window.open("", "_blank");
    if (!win) {
      notify("error", "Please allow popups for this site to view the vaccination card.");
      return;
    }
    try {
      const blobUrl = await getAuthenticatedFileUrl(cardUrl);
      win.location.href = blobUrl;
    } catch (err) {
      win.close();
      notify("error", err.message || "Failed to load vaccination card.");
    }
  };

  const verifyVaccination = async (item) => {
    if (!item || item.type !== "hotel") return;
    try {
      setBusyAction(`${item.id}-vaccination`);
      await apiRequest(`/receptionist/boarding-requests/${item.id}/verify-vaccination`, {
        method: "POST",
      });

      // Immediately update UI to show verified state
      const now = new Date().toISOString();
      if (selectedRequest && selectedRequest.id === item.id) {
        setSelectedRequest((prev) => ({
          ...prev,
          raw: {
            ...prev.raw,
            vaccination_card_verified_at: now,
          },
        }));
      }

      // Also update the item in the requests list
      setRequests((prev) =>
        prev.map((req) =>
          req.id === item.id
            ? {
                ...req,
                raw: {
                  ...req.raw,
                  vaccination_card_verified_at: now,
                },
              }
            : req
        )
      );

      notify("success", "Vaccination card verified.");
      await fetchAll({ silent: true });
    } catch (err) {
      notify("error", err.message || "Failed to verify vaccination card.");
    } finally {
      setBusyAction("");
    }
  };

  const handleAction = async (item, action, extra = {}) => {
    const key = `${item.id}-${action}`;
    setBusyAction(key);
    try {
      let endpoint = "";
      let method = "POST";
      let payload = {};

      const isAppointment = item.source === "appointment";
      const isBoarding = item.source === "boarding";
      const isGrooming = item.source === "grooming";

      // Use service_request ID when available so we never send a boarding/appointment/grooming
      // table ID into the /receptionist/requests/{id} endpoint (which expects a ServiceRequest ID).
      const requestId = item.serviceRequestId || item.id;

      if (action === "approve") {
        if (item.source === "service_request" || item.serviceRequestId) {
          endpoint = `/receptionist/requests/${requestId}/approve`;
        } else if (isBoarding) {
          endpoint = `/receptionist/boarding-requests/${item.id}/approve`;
        } else if (isGrooming) {
          endpoint = `/grooming/${item.id}/status`;
          method = "PUT";
          payload = { status: "approved" };
        } else {
          endpoint = `/receptionist/requests/${requestId}/approve`;
        }

        if (method === "POST") {
          payload = {
            receptionist_remarks: extra.remarks || "Approved by receptionist",
            ...(item.type === "vet" && extra.veterinarianId
              ? { veterinarian_id: Number(extra.veterinarianId) }
              : {}),
          };
        }
      } else if (action === "reject") {
        const reason = extra.reason?.trim()
          ? extra.reason.trim()
          : await showReasonPrompt("Reject this request? Please select a reason.", "Reject Request", "Reject", BOOKING_REJECT_REASONS);
        if (!reason) { setBusyAction(""); return; }

        if (item.source === "service_request" || item.serviceRequestId) {
          endpoint = `/receptionist/requests/${requestId}/reject`;
          payload = { rejection_reason: reason };
        } else if (isBoarding) {
          endpoint = `/receptionist/boarding-requests/${item.id}/reject`;
          payload = { rejection_reason: reason };
        } else if (isGrooming) {
          endpoint = `/grooming/${item.id}/status`;
          method = "PUT";
          payload = { status: "rejected", reason };
        } else {
          endpoint = `/receptionist/requests/${requestId}/reject`;
          payload = { rejection_reason: reason };
        }
      } else if (action === "check_in") {
        const confirmed = await showConfirm(`Check in ${item.petName}?`);
        if (!confirmed) { setBusyAction(""); return; }
        if (isBoarding) {
          endpoint = `/receptionist/boarding-requests/${item.id}/check-in`;
        } else {
          endpoint = `/receptionist/requests/${requestId}/status`;
          method = "PATCH";
          payload = { status: "checked_in" };
        }
        await apiRequest(endpoint, { method, body: JSON.stringify(payload) });
        updateItemStatus(item.id, "checked_in");
        notify("success", "Checked in successfully.");
        setBusyAction("");
        await fetchAll({ silent: true });
        return;
      } else if (action === "check_out") {
        const confirmed = await showConfirm(`Check out ${item.petName}?`);
        if (!confirmed) { setBusyAction(""); return; }
        if (isBoarding) {
          endpoint = `/receptionist/boarding-requests/${item.id}/check-out`;
        } else {
          endpoint = `/receptionist/requests/${requestId}/status`;
          method = "PATCH";
          payload = { status: "completed" };
        }
      } else if (["approved", "in_progress", "completed", "rejected", "cancelled", "pending"].includes(action)) {
        if (isGrooming) {
          endpoint = `/grooming/${item.id}/status`;
          method = "PUT";
          payload = { status: action };
        } else if (isAppointment) {
          endpoint = `/receptionist/appointments/${item.id}`;
          method = "PUT";
          payload = { status: action };
        } else if (isBoarding) {
          endpoint = `/receptionist/boarding-requests/${item.id}`;
          method = "PUT";
          payload = { status: action };
        } else {
          endpoint = `/receptionist/requests/${item.id}/status`;
          method = "PATCH";
          payload = { status: action };
        }
      }

      if (endpoint) {
        await apiRequest(endpoint, { method, body: JSON.stringify(payload) });
      }

      updateItemStatus(item.id, action === "check_out" ? "completed" : action);
      notify("success", `Request updated successfully.`);
      await fetchAll({ silent: true });
    } catch (err) {
      notify("error", err.message || "Action failed.");
    } finally {
      setBusyAction("");
    }
  };

  const openDetail = (item) => {
    setSelectedRequest(item);
    setShowDetailModal(true);
  };

  const closeDetail = () => {
    setShowDetailModal(false);
    setSelectedRequest(null);
  };

  // Check-in is only allowed for paid bookings scheduled for today.
  const canCheckInItem = (item) => {
    if ((item.paymentStatus || "").toLowerCase() !== "paid") {
      return { ok: false, reason: "Booking must be paid before check-in." };
    }
    const scheduled = item.checkIn || item.appointmentDate || item.requestDate;
    if (scheduled) {
      const d = new Date(scheduled);
      const today = new Date();
      if (
        d.getFullYear() !== today.getFullYear() ||
        d.getMonth() !== today.getMonth() ||
        d.getDate() !== today.getDate()
      ) {
        return { ok: false, reason: "Check-in is only allowed on the scheduled date." };
      }
    }
    return { ok: true, reason: "Check In" };
  };

  const getQuickActions = (item) => {
    const actions = [];
    const busy = (action) => isBusy(item.id, action);

    // View details always available
    actions.push(
      <button
        key="view"
        type="button"
        className="hub-action-btn view"
        onClick={() => openDetail(item)}
        title="View Details"
      >
        <FontAwesomeIcon icon={faEye} />
      </button>
    );

    if (item.status === "pending") {
      actions.push(
        <button
          key="approve"
          type="button"
          className="hub-action-btn approve"
          onClick={() => handleAction(item, "approve")}
          disabled={busy("approve")}
          title="Approve"
        >
          <FontAwesomeIcon icon={busy("approve") ? faSpinner : faCheckCircle} spin={busy("approve")} />
        </button>,
        <button
          key="reject"
          type="button"
          className="hub-action-btn reject"
          onClick={() => handleAction(item, "reject")}
          disabled={busy("reject")}
          title="Reject"
        >
          <FontAwesomeIcon icon={busy("reject") ? faSpinner : faTimesCircle} spin={busy("reject")} />
        </button>
      );
    }

    if (item.type === "hotel" && item.status === "approved") {
      const gate = canCheckInItem(item);
      actions.push(
        <button
          key="checkin"
          type="button"
          className="hub-action-btn checkin"
          onClick={() => handleAction(item, "check_in")}
          disabled={busy("check_in") || !gate.ok}
          title={gate.reason}
        >
          <FontAwesomeIcon icon={busy("check_in") ? faSpinner : faSignOutAlt} spin={busy("check_in")} />
          Check In
        </button>
      );
    }

    if (item.type === "hotel" && item.status === "checked_in") {
      actions.push(
        <button
          key="checkout"
          type="button"
          className="hub-action-btn checkout"
          onClick={() => handleAction(item, "check_out")}
          disabled={busy("check_out")}
          title="Check Out"
        >
          <FontAwesomeIcon icon={busy("check_out") ? faSpinner : faSignOutAlt} spin={busy("check_out")} />
          Check Out
        </button>
      );
    }

    if (item.type === "grooming" && item.status === "approved") {
      actions.push(
        <button
          key="start"
          type="button"
          className="hub-action-btn start"
          onClick={() => handleAction(item, "in_progress")}
          disabled={busy("in_progress")}
          title="Start Grooming"
        >
          <FontAwesomeIcon icon={busy("in_progress") ? faSpinner : faClock} spin={busy("in_progress")} />
          Start
        </button>
      );
    }

    if (item.type === "grooming" && item.status === "in_progress") {
      actions.push(
        <button
          key="complete"
          type="button"
          className="hub-action-btn complete"
          onClick={() => handleAction(item, "completed")}
          disabled={busy("completed")}
          title="Mark Complete"
        >
          <FontAwesomeIcon icon={busy("completed") ? faSpinner : faCheckCircle} spin={busy("completed")} />
          Complete
        </button>
      );
    }

    // Reset to pending (for approved/rejected)
    if (["approved", "rejected", "cancelled"].includes(item.status)) {
      actions.push(
        <button
          key="reset"
          type="button"
          className="hub-action-btn reset"
          onClick={() => handleAction(item, "pending")}
          disabled={busy("pending")}
          title="Reset to Pending"
        >
          <FontAwesomeIcon icon={busy("pending") ? faSpinner : faUndoAlt} spin={busy("pending")} />
        </button>
      );
    }

    return actions;
  };

  return (
    <div className="receptionist-hub">
      {/* Toast messages */}
      {success && (
        <div className="hub-toast success">
          <FontAwesomeIcon icon={faCheckCircle} />
          <span>{success}</span>
        </div>
      )}
      {error && (
        <div className="hub-toast error">
          <FontAwesomeIcon icon={faTimesCircle} />
          <span>{error}</span>
        </div>
      )}

      {/* Hero */}
      <section className="hub-hero fade-up">
        <div>
          <span className="hub-eyebrow">
            <FontAwesomeIcon icon={faCalendarCheck} />
            Receptionist Portal
          </span>
          <h1>Appointments &amp; Boarding</h1>
          <p>
            Manage all service requests, appointments, and boarding reservations in one place.
            Filter by type, status, or payment to focus on what matters.
          </p>
          <small>Last updated: {lastUpdated || "Not refreshed yet"}</small>
        </div>
        <div className="hub-hero-actions">
          <button
            type="button"
            className={`hub-hero-btn ${refreshing ? "loading" : ""}`}
            onClick={() => fetchAll({ silent: true })}
            disabled={refreshing}
          >
            <FontAwesomeIcon icon={refreshing ? faSpinner : faRefresh} spin={refreshing} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          <div className="export-dropdown-wrapper" style={{ position: "relative" }}>
            <button type="button" className="hub-hero-btn ghost" onClick={() => setShowExportDropdown(!showExportDropdown)}>
              <FontAwesomeIcon icon={faDownload} />
              Export ▼
            </button>
            {showExportDropdown && (
              <>
                <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }} onClick={() => setShowExportDropdown(false)} />
                <div style={{ position: "absolute", top: "100%", right: 0, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 999, minWidth: 160, overflow: "hidden" }}>
                  <button type="button" className="hub-hero-btn ghost" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("csv")}>Export as CSV</button>
                  <button type="button" className="hub-hero-btn ghost" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("excel")}>Export as Excel</button>
                  <button type="button" className="hub-hero-btn ghost" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("pdf")}>Export as PDF</button>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      {/* Stat Cards */}
      <section className="hub-stats">
        <StatCard
          icon={<FontAwesomeIcon icon={faPaw} />}
          label="Total"
          value={stats.total}
          active={statusFilter === "all" && typeFilter === "all"}
          onClick={() => { setStatusFilter("all"); setTypeFilter("all"); }}
        />
        <StatCard
          icon={<FontAwesomeIcon icon={faClock} />}
          label="Pending"
          value={stats.pending}
          tone="warning"
          active={statusFilter === "pending"}
          onClick={() => setStatusFilter("pending")}
        />
        <StatCard
          icon={<FontAwesomeIcon icon={faCheckCircle} />}
          label="Approved"
          value={stats.approved}
          tone="success"
          active={statusFilter === "approved"}
          onClick={() => setStatusFilter("approved")}
        />
        <StatCard
          icon={<FontAwesomeIcon icon={faBed} />}
          label="Checked In"
          value={stats.checkedIn}
          tone="info"
          active={statusFilter === "checked_in"}
          onClick={() => setStatusFilter("checked_in")}
        />
        <StatCard
          icon={<FontAwesomeIcon icon={faCut} />}
          label="In Progress"
          value={stats.inProgress}
          tone="primary"
          active={statusFilter === "in_progress"}
          onClick={() => setStatusFilter("in_progress")}
        />
        <StatCard
          icon={<FontAwesomeIcon icon={faCalendarCheck} />}
          label="Completed"
          value={stats.completed}
          tone="completed"
          active={statusFilter === "completed"}
          onClick={() => setStatusFilter("completed")}
        />
        <StatCard
          icon={<FontAwesomeIcon icon={faMoneyBillWave} />}
          label="For Payment"
          value={stats.forPayment}
          tone="payment"
          active={paymentFilter === "pending" || paymentFilter === "unpaid"}
          onClick={() => { setPaymentFilter("pending"); setStatusFilter("all"); }}
        />
      </section>

      {/* Filters */}
      <section className="hub-toolbar fade-up">
        <div className="hub-search">
          <FontAwesomeIcon icon={faSearch} />
          <input
            type="text"
            placeholder="Search ID, pet, customer, phone, service, status..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button type="button" onClick={() => setSearchTerm("")}>
              <FontAwesomeIcon icon={faTimes} />
            </button>
          )}
        </div>

        <label className="hub-filter">
          <FontAwesomeIcon icon={faFilter} />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        <label className="hub-filter">
          <FontAwesomeIcon icon={faPaw} />
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        <label className="hub-filter">
          <FontAwesomeIcon icon={faMoneyBillWave} />
          <select value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)}>
            {PAYMENT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        <button type="button" className="hub-clear-btn" onClick={clearFilters}>
          <FontAwesomeIcon icon={faTimes} />
          Clear
        </button>
      </section>

      {/* Table */}
      <section className="hub-table-card fade-up">
        <div className="hub-table-header">
          <div>
            <span className="hub-eyebrow">
              <FontAwesomeIcon icon={faCalendarAlt} />
              Live Queue
            </span>
            <h2>All Requests</h2>
            <p>
              Showing <strong>{sortedRequests.length}</strong> of <strong>{requests.length}</strong> record(s).
            </p>
          </div>
          <div className="hub-table-actions">
            <button type="button" className="hub-new-btn" onClick={() => setShowBookingModal(true)}>
              <FontAwesomeIcon icon={faPlus} /> New Walk-in
            </button>
            <button type="button" className="hub-new-btn secondary" onClick={() => setShowServiceManager(true)}>
              <FontAwesomeIcon icon={faWrench} /> Manage Services
            </button>
            <button type="button" onClick={() => fetchAll({ silent: true })}>
              <FontAwesomeIcon icon={faRefresh} /> Refresh
            </button>
            <div className="export-dropdown-wrapper" style={{ position: "relative" }}>
              <button type="button" onClick={() => setShowExportDropdown(!showExportDropdown)}>
                <FontAwesomeIcon icon={faDownload} /> Export ▼
              </button>
              {showExportDropdown && (
                <>
                  <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }} onClick={() => setShowExportDropdown(false)} />
                  <div style={{ position: "absolute", top: "100%", right: 0, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 999, minWidth: 160, overflow: "hidden" }}>
                    <button type="button" style={{ width: "100%", textAlign: "left" }} onClick={() => handleExport("csv")}>Export as CSV</button>
                    <button type="button" style={{ width: "100%", textAlign: "left" }} onClick={() => handleExport("excel")}>Export as Excel</button>
                    <button type="button" style={{ width: "100%", textAlign: "left" }} onClick={() => handleExport("pdf")}>Export as PDF</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {loading ? (
          <div className="hub-loading-state">
            <FontAwesomeIcon icon={faSpinner} spin />
            <h3>Loading requests...</h3>
            <p>Please wait while all appointments and boardings are loaded.</p>
          </div>
        ) : (
          <div className="hub-table-scroll">
            <table className="hub-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>ID</th>
                  <th>Pet</th>
                  <th>Customer</th>
                  <th>Service</th>
                  <th>Schedule</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th>Amount</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedRequests.map((item) => (
                  <tr key={`${item.type}-${item.id}`}>
                    <td>
                      <span className={`hub-type-badge ${item.type}`}>
                        <TypeIcon type={item.type} />
                        <TypeLabel type={item.type} />
                      </span>
                    </td>
                    <td>
                      <span className="hub-id">#{item.id}</span>
                    </td>
                    <td>
                      <div className="hub-pet-cell">
                        <strong>{item.petName}</strong>
                        <small>{item.petType}{item.breed ? ` · ${item.breed}` : ""}</small>
                      </div>
                    </td>
                    <td>
                      <div className="hub-customer-cell">
                        <FontAwesomeIcon icon={faUser} />
                        <div>
                          <strong>{item.customerName}</strong>
                          {item.customerPhone && <small>{item.customerPhone}</small>}
                        </div>
                      </div>
                    </td>
                    <td>{item.service}</td>
                    <td>
                      <div className="hub-schedule-cell">
                        <strong>{formatDate(item.date)}</strong>
                        {item.time && <small>{formatTime(item.time)}</small>}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={item.status} />
                    </td>
                    <td>
                      <PaymentBadge status={item.paymentStatus} />
                    </td>
                    <td>
                      <span className="hub-amount">{formatCurrency(item.amount)}</span>
                    </td>
                    <td>
                      <RowActionPopover rowLabel={item.petName || item.customerName || item.id}>
                        {getQuickActions(item)}
                      </RowActionPopover>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {sortedRequests.length === 0 && (
              <div className="hub-empty-state">
                <FontAwesomeIcon icon={faSearch} />
                <h3>No records found</h3>
                <p>Try changing your search keyword or filters.</p>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Detail Modal */}
      {showBookingModal && (
        <NewWalkInBookingModal
          onClose={() => setShowBookingModal(false)}
          onSuccess={() => {
            setShowBookingModal(false);
            fetchAll({ silent: true });
            notify("success", "Booking created successfully.");
          }}
        />
      )}

      {showServiceManager && <ServiceManagerModal onClose={() => setShowServiceManager(false)} />}

      {showDetailModal && selectedRequest && (
        <div className="hbk-overlay" onClick={closeDetail}>
          <div className="hbk-modal" onClick={(e) => e.stopPropagation()}>
            <div className="hbk-head">
              <div>
                <span className="hbk-eyebrow">
                  <FontAwesomeIcon icon={faInfoCircle} />
                  Request Details
                </span>
                <h2>
                  <TypeIcon type={selectedRequest.type} /> #{selectedRequest.id}
                </h2>
              </div>
              <button type="button" className="close-btn" onClick={closeDetail}>
                <FontAwesomeIcon icon={faTimes} />
              </button>
            </div>

            <div className="hbk-body">
              <div className="hub-detail-grid">
                <div><small>Pet</small><strong>{selectedRequest.petName}</strong></div>
                <div><small>Type</small><strong>{selectedRequest.petType}{selectedRequest.breed ? ` · ${selectedRequest.breed}` : ""}</strong></div>
                <div><small>Customer</small><strong>{selectedRequest.customerName}</strong></div>
                <div><small>Phone</small><strong>{selectedRequest.customerPhone || "N/A"}</strong></div>
                <div><small>Service</small><strong>{selectedRequest.service}</strong></div>
                <div><small>Type</small><strong><TypeLabel type={selectedRequest.type} /></strong></div>
                <div><small>Date</small><strong>{formatDate(selectedRequest.date)}</strong></div>
                <div><small>Time</small><strong>{formatTime(selectedRequest.time) || "N/A"}</strong></div>
                <div><small>Status</small><StatusBadge status={selectedRequest.status} /></div>
                <div><small>Payment</small><PaymentBadge status={selectedRequest.paymentStatus} /></div>
                <div><small>Amount</small><strong>{formatCurrency(selectedRequest.amount)}</strong></div>
                <div><small>Paid</small><strong>{formatCurrency(selectedRequest.paidAmount)}</strong></div>
              </div>

              {selectedRequest.type === "hotel" && (
                <div className="hub-detail-section">
                  <h4>Boarding Details</h4>
                  <div className="hub-detail-grid">
                    <div><small>Room</small><strong>{selectedRequest.roomType || "N/A"}</strong></div>
                    <div><small>Check-in</small><strong>{formatDate(selectedRequest.checkIn)}</strong></div>
                    <div><small>Check-out</small><strong>{formatDate(selectedRequest.checkOut)}</strong></div>
                  </div>

                  {selectedRequest.raw?.vaccination_card && (
                    <div className="hub-vaccination-section" style={{ marginTop: "16px" }}>
                      <button
                        type="button"
                        className="hbk-btn secondary"
                        onClick={() => openVaccinationCard(selectedRequest.raw?.vaccination_card_url || selectedRequest.raw?.vaccination_card)}
                      >
                        <FontAwesomeIcon icon={faEye} /> View Vaccination Card
                      </button>
                      {selectedRequest.raw?.vaccination_card_verified_at ? (
                        <span className="hub-status-badge status-completed" style={{ marginLeft: "10px", display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <FontAwesomeIcon icon={faCheckCircle} /> Verified
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="hbk-btn approve"
                          onClick={() => verifyVaccination(selectedRequest)}
                          disabled={isBusy(selectedRequest.id, "vaccination")}
                          style={{ marginLeft: "10px" }}
                        >
                          <FontAwesomeIcon icon={isBusy(selectedRequest.id, "vaccination") ? faSpinner : faCheckCircle} spin={isBusy(selectedRequest.id, "vaccination")} />
                          {isBusy(selectedRequest.id, "vaccination") ? "Verifying..." : "Verify Vaccination Card"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="hub-detail-section">
                <h4>Notes</h4>
                <p>{selectedRequest.notes || "No notes provided."}</p>
              </div>

              {/* Vet Assignment for vet appointments */}
              {selectedRequest.type === "vet" && (
                <div className="hub-detail-section">
                  <h4>Veterinarian Assignment</h4>
                  {veterinarians.length === 0 ? (
                    <p className="hub-detail-note">No veterinarians available.</p>
                  ) : (
                    <select
                      className="hub-vet-select"
                      value={vetAssignments[selectedRequest.id] || ""}
                      onChange={(e) =>
                        setVetAssignments((prev) => ({ ...prev, [selectedRequest.id]: e.target.value }))
                      }
                    >
                      <option value="">{selectedRequest.raw?.veterinarian ? `Assigned: ${selectedRequest.raw.veterinarian.name || selectedRequest.raw.veterinarian_id}` : "Select veterinarian..."}</option>
                      {veterinarians.map((vet) => (
                        <option key={vet.id} value={vet.id}>
                          {vet.name || vet.full_name || `Vet #${vet.id}`}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </div>

            <div className="hbk-foot">
              <button type="button" className="hbk-btn secondary" onClick={closeDetail}>
                Close
              </button>

              {selectedRequest.status === "pending" && (
                <>
                  <button
                    type="button"
                    className="hbk-btn approve"
                    onClick={() => {
                      handleAction(selectedRequest, "approve", {
                        veterinarianId: vetAssignments[selectedRequest.id],
                      });
                      closeDetail();
                    }}
                    disabled={isBusy(selectedRequest.id, "approve")}
                  >
                    <FontAwesomeIcon icon={faCheckCircle} /> Approve
                  </button>
                  <button
                    type="button"
                    className="hbk-btn reject"
                    onClick={() => {
                      handleAction(selectedRequest, "reject");
                      closeDetail();
                    }}
                    disabled={isBusy(selectedRequest.id, "reject")}
                  >
                    <FontAwesomeIcon icon={faTimesCircle} /> Reject
                  </button>
                </>
              )}

              {selectedRequest.type === "hotel" && selectedRequest.status === "approved" && (() => {
                const gate = canCheckInItem(selectedRequest);
                return (
                  <button
                    type="button"
                    className="hbk-btn checkin"
                    onClick={() => {
                      handleAction(selectedRequest, "check_in");
                      closeDetail();
                    }}
                    disabled={isBusy(selectedRequest.id, "check_in") || !gate.ok}
                    title={gate.reason}
                  >
                    <FontAwesomeIcon icon={faSignOutAlt} /> Check In
                  </button>
                );
              })()}

              {selectedRequest.type === "hotel" && selectedRequest.status === "checked_in" && (
                <button
                  type="button"
                  className="hbk-btn checkout"
                  onClick={() => {
                    handleAction(selectedRequest, "check_out");
                    closeDetail();
                  }}
                  disabled={isBusy(selectedRequest.id, "check_out")}
                >
                  <FontAwesomeIcon icon={faSignOutAlt} /> Check Out
                </button>
              )}

              {selectedRequest.type === "grooming" && selectedRequest.status === "approved" && (
                <button
                  type="button"
                  className="hbk-btn start"
                  onClick={() => {
                    handleAction(selectedRequest, "in_progress");
                    closeDetail();
                  }}
                  disabled={isBusy(selectedRequest.id, "in_progress")}
                >
                  <FontAwesomeIcon icon={faClock} /> Start Grooming
                </button>
              )}

              {selectedRequest.type === "grooming" && selectedRequest.status === "in_progress" && (
                <button
                  type="button"
                  className="hbk-btn complete"
                  onClick={() => {
                    handleAction(selectedRequest, "completed");
                    closeDetail();
                  }}
                  disabled={isBusy(selectedRequest.id, "completed")}
                >
                  <FontAwesomeIcon icon={faCheckCircle} /> Mark Complete
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReceptionistAppointmentsBoarding;
