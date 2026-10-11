import React, { useCallback, useEffect, useMemo, useState } from "react";
import { showConfirm, showReasonPrompt, BOOKING_REJECT_REASONS } from "../../utils/alert.jsx";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCalendarAlt,
  faCheckCircle,
  faClipboardList,
  faClock,
  faCut,
  faDownload,
  faEye,
  faInfoCircle,
  faPaw,
  faRefresh,
  faShower,
  faSpinner,
  faTimes,
  faTimesCircle,
  faUser,
} from "@fortawesome/free-solid-svg-icons";
import "../../styles/bookingModal.css";
import "./ReceptionistGroomingBookings.css";
import { apiRequest } from "../../api/client";
import { getDateTimeTimestamp } from "../../utils/apiNormalize";
import { exportToCSV, exportToPDF, exportToExcel } from "../../utils/reportExport";
import PetAvatar from "../shared/PetAvatar";
import RowActionPopover from "../shared/RowActionPopover";

const STATUS_OPTIONS = [
  { value: "all", label: "All Status" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
];

const normalizeList = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.requests)) return payload.requests;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.requests)) return payload.data.requests;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
};

const normalizeStatus = (status) => {
  const value = String(status || "pending").toLowerCase().replace(/\s+/g, "_");

  if (value === "scheduled" || value === "confirmed") return "approved";
  if (value === "canceled") return "cancelled";

  return value;
};

const formatStatus = (status) =>
  String(status || "pending")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const formatDate = (value) => {
  if (!value) return "N/A";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
};

const formatTime = (value) => {
  if (!value) return "N/A";

  if (String(value).includes("AM") || String(value).includes("PM")) return value;

  if (String(value).includes("T")) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleTimeString("en-PH", {
        hour: "numeric",
        minute: "2-digit",
      });
    }
  }

  const [hour, minute] = String(value).split(":");
  if (!hour || !minute) return value;

  const date = new Date();
  date.setHours(Number(hour), Number(minute), 0, 0);

  return date.toLocaleTimeString("en-PH", {
    hour: "numeric",
    minute: "2-digit",
  });
};

const getPetName = (item) =>
  item.pet?.name ||
  item.pet_name ||
  item.petName ||
  item.pet ||
  "Unknown Pet";

const getCustomerName = (item) =>
  item.customer?.name ||
  item.customer_name ||
  item.client_name ||
  item.owner_name ||
  item.user?.name ||
  "Unknown Customer";

const getServiceName = (item) =>
  item.service?.name ||
  item.service_name ||
  item.service ||
  item.name ||
  "Grooming Service";

const getAppointmentDate = (item) =>
  item.date ||
  item.request_date ||
  item.booking_date ||
  item.appointment_date ||
  item.scheduled_at ||
  item.created_at ||
  "";

const getAppointmentTime = (item) =>
  item.time ||
  item.request_time ||
  item.booking_time ||
  item.appointment_time ||
  item.scheduled_time ||
  item.scheduled_at ||
  "";

const ReceptionistGroomingBookings = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterService, setFilterService] = useState("all");

  const [groomingAppointments, setGroomingAppointments] = useState([]);
  const [selectedAppointment, setSelectedAppointment] = useState(null);

  const [processingId, setProcessingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");

  const [showExportDropdown, setShowExportDropdown] = useState(false);

  const showMessage = (type, message) => {
    if (type === "success") {
      setSuccess(message);
      window.clearTimeout(window.groomingSuccessTimer);
      window.groomingSuccessTimer = window.setTimeout(() => setSuccess(""), 3000);
      return;
    }

    setError(message);
    window.clearTimeout(window.groomingErrorTimer);
    window.groomingErrorTimer = window.setTimeout(() => setError(""), 5000);
  };

  const normalizeAppointment = (item) => ({
    ...item,
    id: item.id || item.request_id || item.service_request_id,
    petName: getPetName(item),
    customerName: getCustomerName(item),
    serviceName: getServiceName(item),
    dateValue: getAppointmentDate(item),
    timeValue: getAppointmentTime(item),
    status: normalizeStatus(item.status),
    notes:
      item.notes ||
      item.remarks ||
      item.special_request ||
      item.special_requests ||
      item.description ||
      "None",
  });

  const fetchAppointments = useCallback(async ({ silent = false } = {}) => {
    try {
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setError("");

      const data = await apiRequest("/receptionist/requests");
      const normalizedData = normalizeList(data);

      // Filter grooming requests only
      const groomingOnly = normalizedData.filter((item) => {
        const type = String(item.request_type || item.type || item.service_type || "").toLowerCase();
        const serviceName = String(item.service_name || item.service || "").toLowerCase();
        return type === "grooming" || serviceName.includes("grooming");
      });

      const appointments = groomingOnly.map(normalizeAppointment);
      setGroomingAppointments(appointments);
      setLastUpdated(new Date().toLocaleString("en-PH"));
    } catch (err) {
      showMessage("error", err.message || "Failed to load grooming bookings.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchAppointments();
  }, [fetchAppointments]);

  const filteredAppointments = useMemo(() => {
    const keyword = String(searchTerm || "").toLowerCase();
    return groomingAppointments.filter((item) => {
      const matchesSearch =
        !keyword ||
        String(item.petName || "").toLowerCase().includes(keyword) ||
        String(item.customerName || "").toLowerCase().includes(keyword) ||
        String(item.serviceName || "").toLowerCase().includes(keyword);

      const matchesStatus =
        filterStatus === "all" || item.status === filterStatus;

      const matchesService =
        filterService === "all" ||
        String(item.serviceName || "")
          .toLowerCase()
          .includes(filterService.toLowerCase());

      return matchesSearch && matchesStatus && matchesService;
    }).sort((a, b) =>
      getDateTimeTimestamp(a.dateValue, a.timeValue) - getDateTimeTimestamp(b.dateValue, b.timeValue)
    );
  }, [groomingAppointments, searchTerm, filterStatus, filterService]);

  const stats = useMemo(() => {
    const pending = groomingAppointments.filter(
      (a) => a.status === "pending"
    ).length;
    const approved = groomingAppointments.filter(
      (a) => a.status === "approved"
    ).length;
    const inProgress = groomingAppointments.filter(
      (a) => a.status === "in_progress"
    ).length;
    const completed = groomingAppointments.filter(
      (a) => a.status === "completed"
    ).length;
    const rejected = groomingAppointments.filter(
      (a) => a.status === "rejected" || a.status === "cancelled"
    ).length;

    return {
      total: groomingAppointments.length,
      pending,
      approved,
      inProgress,
      completed,
      rejected,
    };
  }, [groomingAppointments]);

  const handleStatusChange = async (id, newStatus, reason = null) => {
    try {
      setProcessingId(id);
      await apiRequest(`/receptionist/requests/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({
          status: newStatus,
          ...(reason ? { rejection_reason: reason } : {}),
        }),
      });

      await fetchAppointments({ silent: true });
      showMessage("success", `Booking status updated to ${formatStatus(newStatus)}`);
    } catch (err) {
      showMessage("error", err.message || "Failed to update status.");
    } finally {
      setProcessingId(null);
    }
  };

  const handleApprove = async (id) => {
    if (!(await showConfirm("Approve this grooming booking?"))) return;
    await handleStatusChange(id, "approved");
  };

  const handleReject = async (id) => {
    const reason = await showReasonPrompt(
      "Reject this grooming booking? Please select a reason.",
      "Reject Grooming Booking",
      "Reject",
      BOOKING_REJECT_REASONS
    );
    if (!reason) return;
    await handleStatusChange(id, "rejected", reason);
  };

  const handleStart = async (id) => {
    await handleStatusChange(id, "in_progress");
  };

  const handleComplete = async (id) => {
    if (!(await showConfirm("Mark this grooming booking as completed?"))) return;
    await handleStatusChange(id, "completed");
  };

  const exportColumns = [
    { key: "id", label: "ID" },
    { key: "petName", label: "Pet" },
    { key: "customerName", label: "Customer" },
    { key: "serviceName", label: "Service" },
    { key: "date", label: "Date" },
    { key: "time", label: "Time" },
    { key: "status", label: "Status" },
    { key: "notes", label: "Notes" },
  ];

  const handleExport = (format) => {
    setShowExportDropdown(false);
    if (filteredAppointments.length === 0) {
      showMessage("error", "No data to export.");
      return;
    }

    const exportData = filteredAppointments.map((item) => ({
      ...item,
      date: formatDate(item.dateValue),
      time: formatTime(item.timeValue),
    }));

    const filename = "grooming-bookings";
    if (format === "csv") exportToCSV(exportData, exportColumns, filename);
    else if (format === "excel") exportToExcel(exportData, exportColumns, filename);
    else if (format === "pdf") exportToPDF(exportData, exportColumns, "Grooming Bookings", filename);

    showMessage("success", "Export downloaded.");
  };

  const isProcessing = (id) => processingId === id;

  return (
    <div className="grooming-bookings">
      {/* Header */}
      <div className="grooming-header">
        <div className="header-title">
          <h1>
            <FontAwesomeIcon icon={faCut} /> Grooming Bookings
          </h1>
          <p>Manage grooming appointments and service scheduling</p>
          <small>Last updated: {lastUpdated || "Not refreshed yet"}</small>
        </div>

        <div className="header-actions">
          <button
            type="button"
            className={`secondary-btn ${refreshing ? "loading" : ""}`}
            onClick={() => fetchAppointments({ silent: true })}
            disabled={refreshing}
          >
            <FontAwesomeIcon icon={faRefresh} spin={refreshing} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>

          <div className="export-dropdown-wrapper" style={{ position: "relative" }}>
            <button type="button" className="secondary-btn" onClick={() => setShowExportDropdown(!showExportDropdown)}>
              <FontAwesomeIcon icon={faDownload} />
              Export ▼
            </button>
            {showExportDropdown && (
              <>
                <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }} onClick={() => setShowExportDropdown(false)} />
                <div style={{ position: "absolute", top: "100%", right: 0, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 999, minWidth: 160, overflow: "hidden" }}>
                  <button type="button" className="secondary-btn" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("csv")}>Export as CSV</button>
                  <button type="button" className="secondary-btn" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("excel")}>Export as Excel</button>
                  <button type="button" className="secondary-btn" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => handleExport("pdf")}>Export as PDF</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="alert alert-error">
          <FontAwesomeIcon icon={faTimesCircle} /> {error}
        </div>
      )}
      {success && (
        <div className="alert alert-success">
          <FontAwesomeIcon icon={faCheckCircle} /> {success}
        </div>
      )}

      {/* Stats */}
      <div className="grooming-stats">
        <div className="stat-card">
          <FontAwesomeIcon icon={faClipboardList} />
          <div>
            <strong>{stats.total}</strong>
            <span>Total</span>
          </div>
        </div>
        <div className="stat-card">
          <FontAwesomeIcon icon={faClock} />
          <div>
            <strong>{stats.pending}</strong>
            <span>Pending</span>
          </div>
        </div>
        <div className="stat-card">
          <FontAwesomeIcon icon={faCheckCircle} />
          <div>
            <strong>{stats.approved}</strong>
            <span>Approved</span>
          </div>
        </div>
        <div className="stat-card">
          <FontAwesomeIcon icon={faShower} />
          <div>
            <strong>{stats.inProgress}</strong>
            <span>In Progress</span>
          </div>
        </div>
        <div className="stat-card">
          <FontAwesomeIcon icon={faCheckCircle} />
          <div>
            <strong>{stats.completed}</strong>
            <span>Completed</span>
          </div>
        </div>
        <div className="stat-card">
          <FontAwesomeIcon icon={faTimesCircle} />
          <div>
            <strong>{stats.rejected}</strong>
            <span>Rejected</span>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="grooming-filters">
        <div className="gb-search-box">
          <input
            type="text"
            placeholder="Search by pet, customer, or service..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="gb-filter-select">
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="loading-state">
          <FontAwesomeIcon icon={faSpinner} spin size="2x" />
          <p>Loading grooming bookings...</p>
        </div>
      ) : (
        <div className="grooming-table-container">
          <table className="grooming-table">
            <thead>
              <tr>
                <th>Pet</th>
                <th>Customer</th>
                <th>Service</th>
                <th>Date</th>
                <th>Time</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredAppointments.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="pet-cell">
                      <PetAvatar pet={{ name: item.petName }} size={36} />
                      <span>{item.petName}</span>
                    </div>
                  </td>
                  <td>
                    <div className="customer-cell">
                      <FontAwesomeIcon icon={faUser} />
                      <span>{item.customerName}</span>
                    </div>
                  </td>
                  <td>
                    <div className="service-cell">
                      <FontAwesomeIcon icon={faCut} />
                      <span>{item.serviceName}</span>
                    </div>
                  </td>
                  <td>{formatDate(item.dateValue)}</td>
                  <td>{formatTime(item.timeValue)}</td>
                  <td>
                    <span className={`status-badge status-${item.status}`}>
                      {formatStatus(item.status)}
                    </span>
                  </td>
                  <td>
                    <RowActionPopover rowLabel={item.petName}>
                      <div className="action-buttons">
                      <button
                        type="button"
                        className="action-btn view-btn"
                        onClick={() => setSelectedAppointment(item)}
                        title="View Details"
                      >
                        <FontAwesomeIcon icon={faEye} />
                      </button>

                      {item.status === "pending" && (
                        <>
                          <button
                            type="button"
                            className="action-btn approve-btn"
                            onClick={() => handleApprove(item.id)}
                            disabled={isProcessing(item.id)}
                            title="Approve"
                          >
                            <FontAwesomeIcon
                              icon={isProcessing(item.id) ? faSpinner : faCheckCircle}
                              spin={isProcessing(item.id)}
                            />
                          </button>
                          <button
                            type="button"
                            className="action-btn reject-btn"
                            onClick={() => handleReject(item.id)}
                            disabled={isProcessing(item.id)}
                            title="Reject"
                          >
                            <FontAwesomeIcon
                              icon={isProcessing(item.id) ? faSpinner : faTimesCircle}
                              spin={isProcessing(item.id)}
                            />
                          </button>
                        </>
                      )}

                      {item.status === "approved" && (
                        <button
                          type="button"
                          className="action-btn start-btn"
                          onClick={() => handleStart(item.id)}
                          disabled={isProcessing(item.id)}
                          title="Start Grooming"
                        >
                          <FontAwesomeIcon
                            icon={isProcessing(item.id) ? faSpinner : faCut}
                            spin={isProcessing(item.id)}
                          />
                        </button>
                      )}

                      {item.status === "in_progress" && (
                        <button
                          type="button"
                          className="action-btn complete-btn"
                          onClick={() => handleComplete(item.id)}
                          disabled={isProcessing(item.id)}
                          title="Mark Complete"
                        >
                          <FontAwesomeIcon
                            icon={isProcessing(item.id) ? faSpinner : faCheckCircle}
                            spin={isProcessing(item.id)}
                          />
                        </button>
                      )}
                      </div>
                    </RowActionPopover>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {filteredAppointments.length === 0 && (
            <div className="empty-state">
              <FontAwesomeIcon icon={faCut} size="3x" />
              <h3>No grooming bookings found</h3>
              <p>Try adjusting your search or filters</p>
            </div>
          )}
        </div>
      )}

      {/* Detail Modal */}
      {selectedAppointment && (
        <div className="hbk-overlay" onClick={() => setSelectedAppointment(null)}>
          <div className="hbk-modal" onClick={(e) => e.stopPropagation()}>
            <div className="hbk-head">
              <h2>
                <FontAwesomeIcon icon={faInfoCircle} /> Booking Details
              </h2>
              <button
                type="button"
                className="close-btn"
                onClick={() => setSelectedAppointment(null)}
              >
                <FontAwesomeIcon icon={faTimes} />
              </button>
            </div>

            <div className="hbk-body">
              <div className="detail-grid">
                <div className="detail-item">
                  <label>Pet Name</label>
                  <span>{selectedAppointment.petName}</span>
                </div>
                <div className="detail-item">
                  <label>Customer</label>
                  <span>{selectedAppointment.customerName}</span>
                </div>
                <div className="detail-item">
                  <label>Service</label>
                  <span>{selectedAppointment.serviceName}</span>
                </div>
                <div className="detail-item">
                  <label>Date</label>
                  <span>{formatDate(selectedAppointment.dateValue)}</span>
                </div>
                <div className="detail-item">
                  <label>Time</label>
                  <span>{formatTime(selectedAppointment.timeValue)}</span>
                </div>
                <div className="detail-item">
                  <label>Status</label>
                  <span className={`status-badge status-${selectedAppointment.status}`}>
                    {formatStatus(selectedAppointment.status)}
                  </span>
                </div>
              </div>

              <div className="detail-section">
                <label>Notes</label>
                <p>{selectedAppointment.notes}</p>
              </div>
            </div>

            <div className="hbk-foot">
              <button
                type="button"
                className="secondary-btn"
                onClick={() => setSelectedAppointment(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReceptionistGroomingBookings;
