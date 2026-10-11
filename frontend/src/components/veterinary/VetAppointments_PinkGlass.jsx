import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showReasonPrompt, STAFF_CANCEL_REASONS } from "../../utils/alert.jsx";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCalendarAlt,
  faUser,
  faPaw,
  faStethoscope,
  faEdit,
  faTrash,
  faClock,
  faCheckCircle,
  faTimesCircle,
  faSpinner,
  faExclamationTriangle,
  faRotateRight,
  faEye,
  faCircleCheck,
  faPlay,
  faNotesMedical,
  faFilter,
  faCalendarDay,
  faChartLine,
  faXmark,
  faMoneyBillWave,
} from "@fortawesome/free-solid-svg-icons";
import { NavLink, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { apiRequest } from "../../api/client";
import "./theme.css";
import "../../styles/bookingModal.css";
import "./VetAppointments_PinkGlass.css";

const isRequestCancelled = (error, signal) =>
  signal?.aborted ||
  error?.name === "AbortError" ||
  error?.message === "Request was cancelled";

const isGenericFetchFailure = (error) =>
  error?.name === "TypeError" && error?.message === "Failed to fetch";

const VetAppointments = () => {
  const navigate = useNavigate();
  const mountedRef = useRef(true);
  const fetchAbortRef = useRef(null);
  const [appointments, setAppointments] = useState([]);
  const [selectedAppointment, setSelectedAppointment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const safeArray = (value) => {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.appointments)) return value.appointments;
    if (Array.isArray(value?.data)) return value.data;
    if (Array.isArray(value?.records)) return value.records;
    return [];
  };

  const formatDate = (value) => {
    if (!value) return "TBD";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "TBD";

    return date.toLocaleDateString("en-PH", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const formatDateKey = (value) => {
    if (!value) return "";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "";

    return date.toISOString().split("T")[0];
  };

  const formatTime = (value) => {
    if (!value) return "TBD";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "TBD";

    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const normalizeStatus = (status) => {
    return String(status || "pending").toLowerCase().replace(/\s+/g, "_");
  };

  const transformAppointment = useCallback((apt) => {
    const scheduledAt =
      apt?.scheduled_at ||
      apt?.appointment_date ||
      apt?.date ||
      apt?.schedule ||
      null;

    const petName =
      apt?.pet?.name ||
      apt?.pet_name ||
      apt?.patient_name ||
      "Unknown Pet";

    const ownerName =
      apt?.customer?.name ||
      apt?.owner?.name ||
      apt?.customer_name ||
      apt?.owner_name ||
      "Unknown Owner";

    const ownerPhone =
      apt?.customer?.phone ||
      apt?.owner?.phone ||
      apt?.customer_phone ||
      apt?.phone ||
      "N/A";

    const serviceName =
      apt?.service?.name ||
      apt?.service_name ||
      apt?.appointment_type ||
      apt?.type ||
      "General Consultation";

    return {
      id: apt?.id,
      raw: apt,
      pet: petName,
      owner: ownerName,
      ownerPhone,
      species: apt?.pet?.species || apt?.species || "Pet",
      breed: apt?.pet?.breed || apt?.breed || "Unknown breed",
      date: formatDate(scheduledAt),
      dateKey: formatDateKey(scheduledAt),
      time: formatTime(scheduledAt),
      service: serviceName,
      price: apt?.price || apt?.amount || apt?.total_amount || null,
      status: normalizeStatus(apt?.status),
      paymentStatus: normalizeStatus(apt?.payment_status),
      notes: apt?.notes || apt?.reason || apt?.description || "",
      scheduledAt,
      createdAt: apt?.created_at || apt?.createdAt || null,
    };
  }, []);

  const fetchAppointments = useCallback(async ({ silent = false } = {}) => {
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    const signal = controller.signal;

    try {
      if (!silent) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }

      const data = await apiRequest("/veterinary/appointments", { signal });
      const appointmentsData = safeArray(data);
      const transformedAppointments = appointmentsData.map(transformAppointment);

      if (!mountedRef.current || signal?.aborted) return;

      setAppointments(transformedAppointments);
      setLastUpdated(new Date());
      setError("");
    } catch (err) {
      if (isRequestCancelled(err, signal) || !mountedRef.current) return;

      if (!isGenericFetchFailure(err)) {
        console.error("Failed to fetch appointments:", err);
      }
      setError("Failed to load appointments. Please try again.");
      setAppointments([]);

      if (!silent) {
        toast.error("Failed to load veterinary appointments.");
      }
    } finally {
      if (mountedRef.current && !signal?.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [transformAppointment]);

  useEffect(() => {
    mountedRef.current = true;

    fetchAppointments({ silent: false });

    const interval = setInterval(() => {
      fetchAppointments({ silent: true });
    }, 15000);

    return () => {
      mountedRef.current = false;
      fetchAbortRef.current?.abort();
      clearInterval(interval);
    };
  }, [fetchAppointments]);

  const statusOptions = useMemo(
    () => [
      { key: "all", label: "All" },
      { key: "pending", label: "Incoming" },
      { key: "approved", label: "Approved" },
      { key: "in_progress", label: "Ongoing" },
      { key: "awaiting_payment", label: "Consultation Done" },
      { key: "completed", label: "Completed" },
      { key: "cancelled", label: "Cancelled" },
    ],
    []
  );

  const statusCounts = useMemo(() => {
    return appointments.reduce(
      (acc, appointment) => {
        acc.all += 1;
        acc[appointment.status] = (acc[appointment.status] || 0) + 1;
        return acc;
      },
      {
        all: 0,
        pending: 0,
        approved: 0,
        in_progress: 0,
        awaiting_payment: 0,
        completed: 0,
        cancelled: 0,
      }
    );
  }, [appointments]);

  const filteredAppointments = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();

    return appointments.filter((appointment) => {
      const matchesFilter = filter === "all" || appointment.status === filter;

      const searchableText = [
        appointment.pet,
        appointment.owner,
        appointment.ownerPhone,
        appointment.species,
        appointment.breed,
        appointment.service,
        appointment.status,
        appointment.notes,
        appointment.date,
        appointment.time,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const matchesSearch = !keyword || searchableText.includes(keyword);

      return matchesFilter && matchesSearch;
    });
  }, [appointments, filter, searchTerm]);

  const todayKey = new Date().toISOString().split("T")[0];

  const dashboardStats = useMemo(() => {
    const todayCount = appointments.filter((item) => item.dateKey === todayKey).length;
    const completedCount = appointments.filter((item) => item.status === "completed").length;
    const pendingCount = appointments.filter((item) => item.status === "pending").length;
    const approvedCount = appointments.filter((item) => item.status === "approved").length;
    const ongoingCount = appointments.filter((item) => item.status === "in_progress").length;
    const awaitingPaymentCount = appointments.filter((item) => item.status === "awaiting_payment").length;
    const completionRate =
      appointments.length > 0
        ? Math.round((completedCount / appointments.length) * 100)
        : 0;

    return {
      todayCount,
      completedCount,
      pendingCount,
      approvedCount,
      ongoingCount,
      awaitingPaymentCount,
      completionRate,
    };
  }, [appointments, todayKey]);

  const getStatusIcon = (status) => {
    switch (status) {
      case "approved":
        return faCheckCircle;
      case "in_progress":
        return faPlay;
      case "awaiting_payment":
        return faMoneyBillWave;
      case "completed":
        return faCircleCheck;
      case "cancelled":
      case "canceled":
      case "rejected":
        return faTimesCircle;
      case "pending":
      default:
        return faClock;
    }
  };

  const getStatusLabel = (status) => {
    switch (status) {
      case "in_progress":
      case "in_consultation":
        return "Ongoing";
      case "awaiting_payment":
        return "Consultation Done";
      case "no_show":
        return "No Show";
      default:
        return String(status || "Pending")
          .replace(/_/g, " ")
          .replace(/\b\w/g, (char) => char.toUpperCase());
    }
  };

  const updateAppointmentStatus = async (appointmentId, nextStatus, reason = null) => {
    if (!appointmentId) {
      toast.error("Appointment ID not found.");
      return;
    }

    try {
      setActionLoadingId(`${appointmentId}-${nextStatus}`);

      if (nextStatus === "in_progress") {
        await apiRequest(`/veterinary/appointments/${appointmentId}/start`, {
          method: "POST",
          body: JSON.stringify({ notes: "Appointment started by veterinarian" }),
        });
      } else {
        await apiRequest(`/veterinary/appointments/${appointmentId}/status`, {
          method: "PATCH",
          body: JSON.stringify({
            status: nextStatus,
            ...(reason ? { reason } : {}),
          }),
        });
      }

      toast.success(`Appointment marked as ${getStatusLabel(nextStatus)}.`);
      await fetchAppointments({ silent: true });

      if (nextStatus === "in_progress") {
        navigate(`/veterinary/appointments/${appointmentId}/consult`);
      }
    } catch (err) {
      console.error("Failed to update appointment:", err);
      const errorMessage =
        err?.response?.data?.message ||
        err?.message ||
        "Failed to update appointment status.";
      toast.error(errorMessage);
    } finally {
      setActionLoadingId(null);
    }
  };

  const cancelAppointment = async (appointmentId) => {
    if (!appointmentId) {
      toast.error("Appointment ID not found.");
      return;
    }

    const reason = await showReasonPrompt(
      "Cancel this appointment? Please select a reason — it will be recorded.",
      "Cancellation reason",
      "Cancel Appointment",
      STAFF_CANCEL_REASONS
    );

    if (reason === null) return;

    await updateAppointmentStatus(appointmentId, "cancelled", reason);
  };

  const completeAppointment = async (appointmentId) => {
    try {
      setActionLoadingId(`${appointmentId}-complete`);
      await apiRequest(`/veterinary/appointments/${appointmentId}/complete`, {
        method: "POST",
      });
      toast.success("Appointment completed and moved to history.");
      setSelectedAppointment(null);
      await fetchAppointments({ silent: true });
    } catch (err) {
      console.error("Failed to complete appointment:", err);
      toast.error(
        err?.response?.data?.message ||
          err?.message ||
          "Failed to complete appointment."
      );
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleRefresh = () => {
    fetchAppointments({ silent: true });
    toast.success("Appointments refreshed.");
  };

  if (loading) {
    return (
      <section className="app-content vet-appointments">
        <div className="vet-loading">
          <div className="vet-loader" />
          <span>Loading veterinary appointments...</span>
        </div>
      </section>
    );
  }

  return (
    <section className="app-content vet-appointments">
      <div className="appointments-hero">
        <div className="header-content">
          <span className="appointments-eyebrow">
            <FontAwesomeIcon icon={faStethoscope} />
            Veterinary Schedule
          </span>
          <h2>
            <FontAwesomeIcon icon={faCalendarAlt} />
            Appointments Management
          </h2>
          <p>Manage veterinary consultations, monitor schedules, and update appointment status.</p>
        </div>
        <div className="appointments-header-actions">
          <button
            className={`refresh-appointments-btn${refreshing ? " refreshing" : ""}`}
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <FontAwesomeIcon icon={faRotateRight} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="error-message">
          <FontAwesomeIcon icon={faExclamationTriangle} />
          <span>{error}</span>
        </div>
      )}

      <div className="appointments-summary">
        <div className="summary-card">
          <div className="summary-icon today">
            <FontAwesomeIcon icon={faCalendarDay} />
          </div>
          <div>
            <h3>Today</h3>
            <div className="today-count">{dashboardStats.todayCount} appointments</div>
          </div>
        </div>

        <div className="summary-card">
          <div className="summary-icon pending">
            <FontAwesomeIcon icon={faClock} />
          </div>
          <div>
            <h3>Pending</h3>
            <div className="today-count">{dashboardStats.pendingCount} waiting</div>
          </div>
        </div>

        <div className="summary-card">
          <div className="summary-icon approved">
            <FontAwesomeIcon icon={faCheckCircle} />
          </div>
          <div>
            <h3>Approved</h3>
            <div className="today-count">{dashboardStats.approvedCount} ready</div>
          </div>
        </div>

        <div className="summary-card">
          <div className="summary-icon completed">
            <FontAwesomeIcon icon={faChartLine} />
          </div>
          <div>
            <h3>Completion Rate</h3>
            <div className="today-count">{dashboardStats.completionRate}%</div>
          </div>
        </div>
      </div>

      <div className="appointments-controls">
        <div className="search-filter">
          <div className="search-box">
            <input
              type="text"
              placeholder="Search by pet, owner, service, status, or notes..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button
                className="clear-search-btn"
                type="button"
                onClick={() => setSearchTerm("")}
                aria-label="Clear search"
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            )}
          </div>

          <div className="filter-panel-label">
            <FontAwesomeIcon icon={faFilter} />
            Filters
          </div>

          <div className="filter-buttons">
            {statusOptions.map((status) => (
              <button
                key={status.key}
                className={`filter-btn${filter === status.key ? " active" : ""}`}
                type="button"
                onClick={() => setFilter(status.key)}
              >
                {status.label} ({statusCounts[status.key] || 0})
              </button>
            ))}
          </div>
        </div>

        <div className="appointments-last-updated">
          <FontAwesomeIcon icon={faClock} />
          Last updated:{" "}
          {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>

      <div className="appointments-grid">
        {filteredAppointments.map((appointment) => {
          const isCompleted = appointment.status === "completed";
          const isCancelled =
            appointment.status === "cancelled" ||
            appointment.status === "canceled" ||
            appointment.status === "rejected";

          const isUnassignedPending =
            appointment.status === "pending" &&
            (!appointment.raw?.veterinarian_id && appointment.raw?.veterinarian_id !== 0);

          const canStart = ["approved", "scheduled"].includes(appointment.status);
          const canConsult = ["in_progress", "treated"].includes(appointment.status);

          return (
            <div className="appointment-card" key={appointment.id || `${appointment.pet}-${appointment.time}`}>
              <div className="appointment-header">
                <div className="appointment-info">
                  <h3>
                    <FontAwesomeIcon icon={faPaw} />
                    {appointment.pet}
                  </h3>
                  <p>
                    <FontAwesomeIcon icon={faUser} />
                    {appointment.owner}
                  </p>
                </div>
                <span className={`appointment-status ${appointment.status}`}>
                  <FontAwesomeIcon icon={getStatusIcon(appointment.status)} />
                  {isUnassignedPending ? "Incoming" : getStatusLabel(appointment.status)}
                </span>
                {isUnassignedPending && (
                  <span style={{ fontSize: "11px", fontWeight: 600, color: "var(--veterinary-warning)", marginLeft: "8px" }}>
                    Unassigned
                  </span>
                )}
              </div>

              <div className="appointment-details">
                <div className="detail-item">
                  <FontAwesomeIcon icon={faCalendarAlt} />
                  <div>
                    <strong>Date &amp; Time</strong>
                    <p>{appointment.date} at {appointment.time}</p>
                  </div>
                </div>

                <div className="detail-item">
                  <FontAwesomeIcon icon={faStethoscope} />
                  <div>
                    <strong>Service</strong>
                    <p>{appointment.service}</p>
                  </div>
                </div>

                <div className="detail-item">
                  <FontAwesomeIcon icon={faPaw} />
                  <div>
                    <strong>Patient</strong>
                    <p>{appointment.species} • {appointment.breed}</p>
                  </div>
                </div>

                {appointment.price && (
                  <div className="detail-item">
                    <FontAwesomeIcon icon={faMoneyBillWave} />
                    <div>
                      <strong>Price</strong>
                      <p>₱{Number(appointment.price).toFixed(2)}</p>
                    </div>
                  </div>
                )}

                {appointment.notes && (
                  <div className="detail-item notes">
                    <FontAwesomeIcon icon={faNotesMedical} />
                    <div>
                      <strong>Notes</strong>
                      <p>{appointment.notes}</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="appointment-actions">
                <button
                  className="action-btn view-btn"
                  type="button"
                  onClick={() => setSelectedAppointment(appointment)}
                >
                  <FontAwesomeIcon icon={faEye} /> View
                </button>

                {!isUnassignedPending && (
                  <>
                    <button
                      className="action-btn start-btn"
                      type="button"
                      disabled={!canStart || actionLoadingId === `${appointment.id}-in_progress`}
                      onClick={() => updateAppointmentStatus(appointment.id, "in_progress")}
                    >
                      <FontAwesomeIcon icon={faPlay} /> Start
                    </button>

                    <button
                      className="action-btn complete-btn"
                      type="button"
                      disabled={!canConsult && appointment.status !== "awaiting_payment"}
                      onClick={() => navigate(`/veterinary/appointments/${appointment.id}/consult`)}
                    >
                      <FontAwesomeIcon icon={faCircleCheck} />
                      {appointment.status === "awaiting_payment" ? "View Consultation" : "Consult"}
                    </button>

                    {appointment.status === "awaiting_payment" && (
                      <button
                        className="action-btn complete-btn"
                        type="button"
                        disabled={
                          appointment.paymentStatus !== "paid" ||
                          actionLoadingId === `${appointment.id}-complete`
                        }
                        title={
                          appointment.paymentStatus !== "paid"
                            ? "Waiting for cashier to verify payment"
                            : "Mark this appointment as completed"
                        }
                        onClick={() => completeAppointment(appointment.id)}
                      >
                        <FontAwesomeIcon icon={faCheckCircle} /> Complete
                      </button>
                    )}

                    <NavLink
                      className="action-btn edit-btn"
                      to={`/veterinary/appointments/${appointment.id}/edit`}
                      style={{
                        pointerEvents: ["awaiting_payment", "completed"].includes(appointment.status) ? "none" : "auto",
                        opacity: ["awaiting_payment", "completed"].includes(appointment.status) ? 0.5 : 1,
                      }}
                    >
                      <FontAwesomeIcon icon={faEdit} /> Edit
                    </NavLink>

                    <button
                      className="action-btn delete-btn"
                      type="button"
                      disabled={isCompleted || isCancelled || appointment.status === "awaiting_payment"}
                      onClick={() => cancelAppointment(appointment.id)}
                    >
                      <FontAwesomeIcon icon={faTrash} /> Cancel
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {filteredAppointments.length === 0 && (
        <div className="no-appointments">
          <FontAwesomeIcon icon={faCalendarAlt} />
          <h3>No appointments found</h3>
          <p>
            {searchTerm
              ? "Try another pet name, owner name, service, or status."
              : "No appointments match the current filter."}
          </p>
        </div>
      )}

      {selectedAppointment && (
        <div className="hbk-overlay" onClick={() => setSelectedAppointment(null)}>
          <div className="hbk-modal" onClick={(e) => e.stopPropagation()}>
            <div className="hbk-head">
              <div>
                <h3>{selectedAppointment.pet}</h3>
                <p>{selectedAppointment.owner}</p>
              </div>
              <button
                className="close-btn"
                type="button"
                onClick={() => setSelectedAppointment(null)}
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </div>

            <div className="hbk-body">
              <div className="modal-detail">
                <strong>Status</strong>
                <span className={`appointment-status ${selectedAppointment.status}`}>
                  <FontAwesomeIcon icon={getStatusIcon(selectedAppointment.status)} />
                  {getStatusLabel(selectedAppointment.status)}
                </span>
              </div>

              <div className="modal-detail">
                <strong>Date</strong>
                <p>{selectedAppointment.date}</p>
              </div>

              <div className="modal-detail">
                <strong>Time</strong>
                <p>{selectedAppointment.time}</p>
              </div>

              <div className="modal-detail">
                <strong>Service</strong>
                <p>{selectedAppointment.service}</p>
              </div>

              <div className="modal-detail">
                <strong>Patient</strong>
                <p>{selectedAppointment.species} • {selectedAppointment.breed}</p>
              </div>

              <div className="modal-detail">
                <strong>Owner Contact</strong>
                <p>{selectedAppointment.ownerPhone}</p>
              </div>

              <div className="modal-detail full">
                <strong>Notes</strong>
                <p>{selectedAppointment.notes || "No notes provided."}</p>
              </div>
            </div>

            <div className="hbk-foot">
              <button
                className="action-btn start-btn"
                type="button"
                disabled={!["approved", "scheduled"].includes(selectedAppointment.status)}
                onClick={() => updateAppointmentStatus(selectedAppointment.id, "in_progress")}
              >
                <FontAwesomeIcon icon={faPlay} /> Start
              </button>

              <button
                className="action-btn complete-btn"
                type="button"
                disabled={!["in_progress", "in_consultation", "treated", "awaiting_payment"].includes(selectedAppointment.status)}
                onClick={() => navigate(`/veterinary/appointments/${selectedAppointment.id}/consult`)}
              >
                <FontAwesomeIcon icon={faCircleCheck} />
                {selectedAppointment.status === "awaiting_payment" ? "View Consultation" : "Consult"}
              </button>

              {selectedAppointment.status === "awaiting_payment" && (
                <button
                  className="action-btn complete-btn"
                  type="button"
                  disabled={
                    selectedAppointment.paymentStatus !== "paid" ||
                    actionLoadingId === `${selectedAppointment.id}-complete`
                  }
                  title={
                    selectedAppointment.paymentStatus !== "paid"
                      ? "Waiting for cashier to verify payment"
                      : "Mark this appointment as completed"
                  }
                  onClick={() => completeAppointment(selectedAppointment.id)}
                >
                  <FontAwesomeIcon icon={faCheckCircle} /> Complete
                </button>
              )}

              <button
                className="action-btn delete-btn"
                type="button"
                disabled={
                  selectedAppointment.status === "completed" ||
                  selectedAppointment.status === "cancelled" ||
                  selectedAppointment.status === "awaiting_payment"
                }
                onClick={() => cancelAppointment(selectedAppointment.id)}
              >
                <FontAwesomeIcon icon={faTrash} /> Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default VetAppointments;

