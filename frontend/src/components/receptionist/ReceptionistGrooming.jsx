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
  faSearch,
  faShower,
  faSpinner,
  faTimes,
  faTimesCircle,
  faUser,
  faWrench,
} from "@fortawesome/free-solid-svg-icons";
import "../../styles/bookingModal.css";
import "./ReceptionistGrooming.css";
import { apiRequest } from "../../api/client";
import { exportToCSV, exportToPDF, exportToExcel } from "../../utils/reportExport";
import PetAvatar from "../shared/PetAvatar";
import RowActionPopover from "../shared/RowActionPopover";
import GroomingInventoryUsage from "../grooming/GroomingInventoryUsage";
import ServiceBillingPanel from "../shared/ServiceBillingPanel";
import ServiceManagerModal from "./ServiceManagerModal";

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

const Grooming = () => {
  const [showServiceManager, setShowServiceManager] = useState(false);
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
      const list = normalizeList(data);

      const groomingOnly = list
        .filter((item) => {
          const type = String(
            item.type ||
              item.request_type ||
              item.service_type ||
              item.category ||
              item.source ||
              ""
          ).toLowerCase();

          const serviceName = getServiceName(item).toLowerCase();

          return type.includes("groom") || serviceName.includes("groom");
        })
        .map(normalizeAppointment);

      setGroomingAppointments(groomingOnly);
      setLastUpdated(new Date().toLocaleString("en-PH"));
    } catch (err) {
      console.error("Failed to load grooming appointments:", err);
      showMessage("error", err.message || "Failed to load grooming appointments.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const handleBillingRefresh = useCallback(
    () => fetchAppointments({ silent: true }),
    [fetchAppointments]
  );

  useEffect(() => {
    fetchAppointments();

    const intervalId = setInterval(() => {
      fetchAppointments({ silent: true });
    }, 30000);

    return () => clearInterval(intervalId);
  }, [fetchAppointments]);

  const handleStatusUpdate = async (appointment, newStatus) => {
    if (!appointment?.id) {
      showMessage("error", "Invalid appointment ID.");
      return;
    }

    let rejectionReason = null;
    if (newStatus === "rejected") {
      rejectionReason = await showReasonPrompt(
        "Reject this grooming appointment? Please select a reason.",
        "Reject Grooming Appointment",
        "Reject",
        BOOKING_REJECT_REASONS
      );
      if (!rejectionReason) return;
    }

    try {
      setProcessingId(appointment.id);
      setError("");

      // Use dedicated approve endpoint for approval so backend creates Grooming record
      if (newStatus === "approved") {
        await apiRequest(`/receptionist/requests/${appointment.id}/approve`, {
          method: "POST",
          body: JSON.stringify({
            receptionist_remarks: "Approved via grooming dashboard",
          }),
        });
      } else if (newStatus === "rejected") {
        await apiRequest(`/receptionist/requests/${appointment.id}/reject`, {
          method: "POST",
          body: JSON.stringify({
            rejection_reason: rejectionReason,
          }),
        });
      } else {
        await apiRequest(`/receptionist/requests/${appointment.id}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: newStatus }),
        });
      }

      setGroomingAppointments((prev) =>
        prev.map((item) =>
          item.id === appointment.id ? { ...item, status: normalizeStatus(newStatus) } : item
        )
      );

      setSelectedAppointment((prev) =>
        prev?.id === appointment.id ? { ...prev, status: normalizeStatus(newStatus) } : prev
      );

      showMessage("success", `Appointment marked as ${formatStatus(newStatus)}.`);
      await fetchAppointments({ silent: true });
    } catch (err) {
      console.error("Failed to update grooming appointment:", err);
      showMessage("error", err.message || "Failed to update status.");
    } finally {
      setProcessingId(null);
    }
  };

  const serviceOptions = useMemo(() => {
    const services = groomingAppointments
      .map((item) => item.serviceName)
      .filter(Boolean);

    return Array.from(new Set(services));
  }, [groomingAppointments]);

  const filteredAppointments = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();

    return groomingAppointments.filter((appointment) => {
      const searchableText = [
        appointment.id,
        appointment.petName,
        appointment.customerName,
        appointment.serviceName,
        appointment.status,
        appointment.notes,
        appointment.dateValue,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const matchesSearch = !keyword || searchableText.includes(keyword);
      const matchesStatus =
        filterStatus === "all" || normalizeStatus(appointment.status) === filterStatus;
      const matchesService =
        filterService === "all" || appointment.serviceName === filterService;

      return matchesSearch && matchesStatus && matchesService;
    });
  }, [groomingAppointments, searchTerm, filterStatus, filterService]);

  const stats = useMemo(
    () => ({
      total: groomingAppointments.length,
      pending: groomingAppointments.filter((item) => item.status === "pending").length,
      approved: groomingAppointments.filter((item) => item.status === "approved").length,
      inProgress: groomingAppointments.filter((item) => item.status === "in_progress").length,
      completed: groomingAppointments.filter((item) => item.status === "completed").length,
    }),
    [groomingAppointments]
  );

  const getStatusColor = (status) => {
    const value = normalizeStatus(status);

    if (value === "approved") return "info";
    if (value === "pending") return "warning";
    if (value === "in_progress") return "primary";
    if (value === "completed") return "success";
    if (value === "cancelled" || value === "rejected") return "danger";

    return "secondary";
  };

  const getStatusIcon = (status) => {
    const value = normalizeStatus(status);

    if (value === "completed") return faCheckCircle;
    if (value === "cancelled" || value === "rejected") return faTimesCircle;

    return faClock;
  };

  const getServiceIcon = (service) => {
    const value = String(service || "").toLowerCase();

    if (value.includes("bath") || value.includes("wash")) return faShower;
    return faCut;
  };

  const clearFilters = () => {
    setSearchTerm("");
    setFilterStatus("all");
    setFilterService("all");
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
      showMessage("error", "No grooming appointments to export.");
      return;
    }

    const exportData = filteredAppointments.map((item) => ({
      ...item,
      date: formatDate(item.dateValue),
      time: formatTime(item.timeValue),
      status: formatStatus(item.status),
    }));

    const filename = "grooming-appointments";
    if (format === "csv") exportToCSV(exportData, exportColumns, filename);
    else if (format === "excel") exportToExcel(exportData, exportColumns, filename);
    else if (format === "pdf") exportToPDF(exportData, exportColumns, "Grooming Appointments", filename);

    showMessage("success", "Grooming appointments exported.");
  };

  const isProcessing = (appointment) => processingId === appointment.id;

  return (
    <div className="grooming">
      {error && (
        <div className="grooming-toast error">
          <FontAwesomeIcon icon={faTimesCircle} />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="grooming-toast success">
          <FontAwesomeIcon icon={faCheckCircle} />
          <span>{success}</span>
        </div>
      )}

      <section className="grooming-hero">
        <div>
          <span className="grooming-eyebrow">
            <FontAwesomeIcon icon={faCut} />
            Receptionist Grooming Operations
          </span>

          <h1>Grooming Appointments</h1>

          <p>
            Review grooming requests, approve appointments, start active services,
            mark completed grooming sessions, and monitor the grooming queue.
          </p>

          <small>Last updated: {lastUpdated || "Not refreshed yet"}</small>
        </div>

        <div className="grooming-hero-actions">
          <button
            type="button"
            className="secondary-btn"
            onClick={() => setShowServiceManager(true)}
          >
            <FontAwesomeIcon icon={faWrench} />
            Manage Services
          </button>

          <button
            type="button"
            className={`secondary-btn ${refreshing ? "loading" : ""}`}
            onClick={() => fetchAppointments({ silent: true })}
            disabled={refreshing}
          >
            <FontAwesomeIcon icon={refreshing ? faSpinner : faRefresh} />
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
      </section>

      {showServiceManager && (
        <ServiceManagerModal onClose={() => setShowServiceManager(false)} />
      )}

      <section className="grooming-summary-grid">
        <button type="button" className="grooming-summary-card" onClick={() => setFilterStatus("all")}>
          <span>
            <FontAwesomeIcon icon={faCut} />
          </span>
          <div>
            <strong>{stats.total}</strong>
            <p>Total Appointments</p>
          </div>
        </button>

        <button type="button" className="grooming-summary-card warning" onClick={() => setFilterStatus("pending")}>
          <span>
            <FontAwesomeIcon icon={faClock} />
          </span>
          <div>
            <strong>{stats.pending}</strong>
            <p>Pending</p>
          </div>
        </button>

        <button type="button" className="grooming-summary-card info" onClick={() => setFilterStatus("approved")}>
          <span>
            <FontAwesomeIcon icon={faCalendarAlt} />
          </span>
          <div>
            <strong>{stats.approved}</strong>
            <p>Approved</p>
          </div>
        </button>

        <button type="button" className="grooming-summary-card active" onClick={() => setFilterStatus("in_progress")}>
          <span>
            <FontAwesomeIcon icon={faShower} />
          </span>
          <div>
            <strong>{stats.inProgress}</strong>
            <p>In Progress</p>
          </div>
        </button>

        <button type="button" className="grooming-summary-card success" onClick={() => setFilterStatus("completed")}>
          <span>
            <FontAwesomeIcon icon={faCheckCircle} />
          </span>
          <div>
            <strong>{stats.completed}</strong>
            <p>Completed</p>
          </div>
        </button>
      </section>

      <section className="grooming-controls">
        <div className="grooming-search-box">
          <input
            type="text"
            placeholder="Search pet, customer, service, notes, or status..."
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />

          {searchTerm && (
            <button type="button" onClick={() => setSearchTerm("")}>
              <FontAwesomeIcon icon={faTimes} />
            </button>
          )}
        </div>

        <label className="grooming-filter-box">
          <select
            value={filterStatus}
            onChange={(event) => setFilterStatus(event.target.value)}
          >
            {STATUS_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="grooming-filter-box">
          <select
            value={filterService}
            onChange={(event) => setFilterService(event.target.value)}
          >
            <option value="all">All Services</option>
            {serviceOptions.map((service) => (
              <option value={service} key={service}>
                {service}
              </option>
            ))}
          </select>
        </label>

        <button type="button" className="clear-btn" onClick={clearFilters}>
          <FontAwesomeIcon icon={faTimes} />
          Clear
        </button>
      </section>

      <section className="grooming-table-card">
        <div className="grooming-table-header">
          <div>
            <span className="grooming-eyebrow">
              <FontAwesomeIcon icon={faPaw} />
              Live Grooming Queue
            </span>

            <h2>Grooming Requests</h2>

            <p>
              Showing <strong>{filteredAppointments.length}</strong> of{" "}
              <strong>{groomingAppointments.length}</strong> appointment(s).
            </p>
          </div>
        </div>

        {loading ? (
          <div className="grooming-state">
            <FontAwesomeIcon icon={faSpinner} spin />
            <h3>Loading grooming appointments...</h3>
            <p>Please wait while the system loads live grooming requests.</p>
          </div>
        ) : (
          <div className="grooming-table-scroll">
            <table className="grooming-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Pet</th>
                  <th>Customer</th>
                  <th>Service</th>
                  <th>Schedule</th>
                  <th>Notes</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>

              <tbody>
                {filteredAppointments.length === 0 && (
                  <tr>
                    <td colSpan="8">
                      <div className="grooming-empty-state">
                        <FontAwesomeIcon icon={faSearch} />
                        <h3>No grooming records found</h3>
                        <p>Try adjusting the search keyword, status, or service filter.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {filteredAppointments.map((appointment) => (
                  <tr key={appointment.id} className="appointment-row">
                    <td className="appointment-id">
                      <span className="id-badge">#{appointment.id}</span>
                    </td>

                    <td className="pet-info">
                      <div className="pet-details">
                        <PetAvatar pet={appointment.pet} size={40} className="pet-avatar" />
                        <div>
                          <span className="pet-name">{appointment.petName}</span>
                          <small>
                            {appointment.pet?.species ||
                              appointment.pet_species ||
                              appointment.pet_type ||
                              "Pet"}
                          </small>
                        </div>
                      </div>
                    </td>

                    <td className="customer-cell">
                      <FontAwesomeIcon icon={faUser} />
                      <div>
                        <strong>{appointment.customerName}</strong>
                        <small>{appointment.customer?.phone || appointment.customer_phone || "No phone"}</small>
                      </div>
                    </td>

                    <td className="service">
                      <div className="service-info">
                        <FontAwesomeIcon icon={getServiceIcon(appointment.serviceName)} />
                        <span>{appointment.serviceName}</span>
                      </div>
                    </td>

                    <td className="datetime">
                      <div className="datetime-details">
                        <div className="date">
                          <FontAwesomeIcon icon={faCalendarAlt} />
                          {formatDate(appointment.dateValue)}
                        </div>
                        <div className="time">{formatTime(appointment.timeValue)}</div>
                      </div>
                    </td>

                    <td className="notes">
                      <span className="notes-text">{appointment.notes}</span>
                    </td>

                    <td className="status">
                      <span className={`status-badge ${getStatusColor(appointment.status)}`}>
                        <FontAwesomeIcon icon={getStatusIcon(appointment.status)} />
                        {formatStatus(appointment.status)}
                      </span>
                    </td>

                    <td className="actions">
                      <RowActionPopover rowLabel={appointment.petName}>
                      <button
                        type="button"
                        className="action-btn view-btn"
                        onClick={() => setSelectedAppointment(appointment)}
                        title="View Details"
                      >
                        <FontAwesomeIcon icon={faEye} />
                      </button>

                      {appointment.status === "pending" && (
                        <>
                          <button
                            type="button"
                            className="action-btn approve-btn"
                            onClick={() => handleStatusUpdate(appointment, "approved")}
                            title="Approve"
                            disabled={isProcessing(appointment)}
                          >
                            <FontAwesomeIcon
                              icon={isProcessing(appointment) ? faSpinner : faCheckCircle}
                              spin={isProcessing(appointment)}
                            />
                          </button>

                          <button
                            type="button"
                            className="action-btn reject-btn"
                            onClick={() => handleStatusUpdate(appointment, "rejected")}
                            title="Reject"
                            disabled={isProcessing(appointment)}
                          >
                            <FontAwesomeIcon icon={faTimesCircle} />
                          </button>
                        </>
                      )}

                      {appointment.status === "approved" && (
                        <button
                          type="button"
                          className="action-btn start-btn"
                          onClick={() => handleStatusUpdate(appointment, "in_progress")}
                          title="Start Grooming"
                          disabled={isProcessing(appointment)}
                        >
                          <FontAwesomeIcon
                            icon={isProcessing(appointment) ? faSpinner : faClock}
                            spin={isProcessing(appointment)}
                          />
                        </button>
                      )}

                      {appointment.status === "in_progress" && (
                        <button
                          type="button"
                          className="action-btn complete-btn"
                          onClick={() => handleStatusUpdate(appointment, "completed")}
                          title="Mark Complete"
                          disabled={isProcessing(appointment)}
                        >
                          <FontAwesomeIcon
                            icon={isProcessing(appointment) ? faSpinner : faCheckCircle}
                            spin={isProcessing(appointment)}
                          />
                        </button>
                      )}
                      </RowActionPopover>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedAppointment && (
        <div className="hbk-overlay" onClick={() => setSelectedAppointment(null)}>
          <div className="hbk-modal" onClick={(event) => event.stopPropagation()}>
            <div className="hbk-head">
              <div>
                <span className="grooming-eyebrow">
                  <FontAwesomeIcon icon={faInfoCircle} />
                  Appointment Details
                </span>
                <h2>Grooming #{selectedAppointment.id}</h2>
              </div>

              <button
                type="button"
                className="close-btn"
                onClick={() => setSelectedAppointment(null)}
              >
                <FontAwesomeIcon icon={faTimes} />
              </button>
            </div>

            {/* Grooming Supply Usage Section */}
            {selectedAppointment?.id && (
              <div className="grooming-inventory-section">
                <h4>
                  <FontAwesomeIcon icon={faClipboardList} />
                  Grooming Supply Usage
                </h4>
                <GroomingInventoryUsage 
                  groomingId={selectedAppointment.id}
                  petId={selectedAppointment.pet_id || selectedAppointment.pet?.id}
                />
              </div>
            )}

            {/* Itemized billing: additional charges and discounts */}
            {selectedAppointment?.id && selectedAppointment.status !== "pending" && selectedAppointment.status !== "rejected" && (
              <div className="grooming-inventory-section">
                <ServiceBillingPanel
                  serviceType="grooming"
                  serviceId={selectedAppointment.id}
                  petId={selectedAppointment.pet_id || selectedAppointment.pet?.id}
                  onBillingUpdate={handleBillingRefresh}
                />
              </div>
            )}

            <div className="hbk-body">
              <div className="info-grid">
                <InfoItem label="Pet" value={selectedAppointment.petName} />
                <InfoItem label="Customer" value={selectedAppointment.customerName} />
                <InfoItem label="Service" value={selectedAppointment.serviceName} />
                <InfoItem label="Date" value={formatDate(selectedAppointment.dateValue)} />
                <InfoItem label="Time" value={formatTime(selectedAppointment.timeValue)} />
                <InfoItem label="Status" value={formatStatus(selectedAppointment.status)} />
                <InfoItem label="Notes" value={selectedAppointment.notes} wide />
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

              {selectedAppointment.status === "pending" && (
                <>
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={() => handleStatusUpdate(selectedAppointment, "approved")}
                    disabled={isProcessing(selectedAppointment)}
                  >
                    <FontAwesomeIcon icon={faCheckCircle} />
                    Approve
                  </button>

                  <button
                    type="button"
                    className="danger-btn"
                    onClick={() => handleStatusUpdate(selectedAppointment, "rejected")}
                    disabled={isProcessing(selectedAppointment)}
                  >
                    <FontAwesomeIcon icon={faTimesCircle} />
                    Reject
                  </button>
                </>
              )}

              {selectedAppointment.status === "approved" && (
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => handleStatusUpdate(selectedAppointment, "in_progress")}
                  disabled={isProcessing(selectedAppointment)}
                >
                  <FontAwesomeIcon icon={faClock} />
                  Start Grooming
                </button>
              )}

              {selectedAppointment.status === "in_progress" && (
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => handleStatusUpdate(selectedAppointment, "completed")}
                  disabled={isProcessing(selectedAppointment)}
                >
                  <FontAwesomeIcon icon={faCheckCircle} />
                  Complete
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const InfoItem = ({ label, value, wide = false }) => (
  <div className={`info-item ${wide ? "full-width" : ""}`}>
    <label>{label}</label>
    <span>{value || "N/A"}</span>
  </div>
);

export default Grooming;