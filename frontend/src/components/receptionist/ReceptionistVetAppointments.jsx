import React, { useState, useEffect } from "react";
import { showConfirm, showError, showWarning, showReasonPrompt, STAFF_CANCEL_REASONS } from "../../utils/alert.jsx";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faStethoscope,
  faCalendarAlt,
  faPlus,
  faEdit,
  faTrash,
  faCheckCircle,
  faTimesCircle,
  faClock,
  faPaw,
  faUserMd,
  faNotesMedical,
  faSyringe,
  faHeartbeat,
  faPhone,
  faSpinner,
  faExclamationTriangle,
  faCheck,
  faTasks,
  faTimes,
  faWrench,
} from "@fortawesome/free-solid-svg-icons";
import { apiRequest } from "../../api/client";
import ServiceManagerModal from "./ServiceManagerModal";
import PetAvatar from "../shared/PetAvatar";
import RowActionPopover from "../shared/RowActionPopover";
import "../../styles/bookingModal.css";
import "./ReceptionistVetAppointments.css";

const VetAppointments = () => {
  const [showServiceManager, setShowServiceManager] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterDoctor, setFilterDoctor] = useState("all");
  const [selectedAppointment, setSelectedAppointment] = useState(null);
  const [appointments, setAppointments] = useState([]);
  const [veterinarians, setVeterinarians] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [selectedVet, setSelectedVet] = useState("");
  const [vetAssignments, setVetAssignments] = useState({});
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Fetch appointments and veterinarians on mount
  useEffect(() => {
    fetchAppointments();
    fetchVeterinarians();
  }, []);

  const isVetRequest = (item) => {
    const values = [
      item.type,
      item.request_type,
      item.service_type,
      item.category,
      item.source,
      item.service_name,
      item.service,
      item.name,
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());

    return values.some(
      (value) =>
        value === "vet" ||
        value === "veterinary" ||
        value.includes("veterinary") ||
        value.includes("consult") ||
        value.includes("vaccination") ||
        value.includes("medical")
    );
  };

  const fetchAppointments = async () => {
    try {
      setLoading(true);
      const data = await apiRequest("/receptionist/requests");
      
      // Filter only vet requests using robust type detection
      const requestData = Array.isArray(data) ? data : (data.requests || []);
      const vetOnly = requestData.filter(isVetRequest);
      
      const transformedAppointments = vetOnly.map(item => ({
        id: `APT-${String(item.id).padStart(3, '0')}`,
        rawId: item.id,
        appointmentId: item.appointment_id || item.appointment?.id || null,
        petName: item.pet,
        petType: "Pet",
        breed: "Unknown",
        owner: item.customer,
        ownerPhone: "N/A",
        doctor: "Unassigned",
        appointmentDate: item.date,
        appointmentTime: item.time,
        duration: "30 mins",
        service: item.service,
        status: item.status,
        notes: item.notes || "",
        urgency: "medium",
      }));
      
      setAppointments(transformedAppointments);
      setError("");
    } catch (err) {
      setError("Failed to load appointments. Please try again.");
      showError("Failed to load appointments. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const fetchVeterinarians = async () => {
    try {
      const response = await apiRequest("/receptionist/veterinarians/available");
      const vets = response.veterinarians || response.data || response;
      const vetList = Array.isArray(vets) ? vets : [];

      setVeterinarians(vetList);

      if (vetList.length === 0) {
        setError("No active veterinarian accounts found. Create or activate a veterinarian user first.");
        showWarning("No active veterinarian accounts found. Create or activate a veterinarian user first.");
      }
    } catch (err) {
      setError("Could not load veterinarian list. Please refresh or check the receptionist permission.");
      showError("Could not load veterinarian list. Please refresh or check the receptionist permission.");
      setVeterinarians([]);
    }
  };

  // Approve appointment
  const handleApprove = async (appointmentId) => {
    const veterinarianId = vetAssignments[appointmentId] || selectedVet;

    if (!veterinarianId) {
      setError("Please choose a veterinarian before approving this appointment.");
      showWarning("Please choose a veterinarian before approving this appointment.");
      return;
    }

    try {
      setActionLoading(true);
      await apiRequest(`/receptionist/requests/${appointmentId}/approve`, {
        method: "POST",
        body: JSON.stringify({ veterinarian_id: Number(veterinarianId) }),
      });
      
      await fetchAppointments();
      setSelectedAppointment(null);
      setSelectedVet("");
      setError("");
    } catch (err) {
      setError(err.message || "Failed to approve appointment");
      showError(err.message || "Failed to approve appointment");
    } finally {
      setActionLoading(false);
    }
  };

  // Cancel appointment
  const handleCancel = async (appointmentId) => {
    const reason = await showReasonPrompt(
      "Cancel this appointment? Please select a reason.",
      "Cancel Appointment",
      "Cancel Appointment",
      STAFF_CANCEL_REASONS
    );
    if (!reason) return;

    try {
      setActionLoading(true);
      await apiRequest(`/receptionist/requests/${appointmentId}/reject`, {
        method: "POST",
        body: JSON.stringify({ rejection_reason: reason }),
      });
      
      await fetchAppointments();
      setSelectedAppointment(null);
      setError("");
    } catch (err) {
      setError(err.message || "Failed to cancel appointment");
      showError(err.message || "Failed to cancel appointment");
    } finally {
      setActionLoading(false);
    }
  };

  // Reschedule appointment
  // ── Bulk actions ──────────────────────────────────────────

  const toggleSelect = (rawId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(rawId)) next.delete(rawId); else next.add(rawId);
      return next;
    });
  };

  const selectAllVisible = () => {
    const visiblePending = filteredAppointments.filter((a) => a.status === "pending");
    if (visiblePending.length === 0) return;
    const allSelected = visiblePending.every((a) => selectedIds.has(a.rawId));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      visiblePending.forEach((a) => {
        if (allSelected) next.delete(a.rawId); else next.add(a.rawId);
      });
      return next;
    });
  };

  const handleBulkApprove = async () => {
    const ids = Array.from(selectedIds);
    const withoutVet = ids.filter((id) => !vetAssignments[id]);
    if (withoutVet.length > 0) { setError("Please assign a veterinarian to every selected appointment."); showWarning("Please assign a veterinarian to every selected appointment."); return; }
    if (!(await showConfirm(`Approve ${ids.length} selected appointments?`))) return;
    setActionLoading(true);
    setError("");
    try {
      await Promise.all(
        ids.map((id) =>
          apiRequest(`/receptionist/requests/${id}/approve`, {
            method: "POST",
            body: JSON.stringify({ veterinarian_id: Number(vetAssignments[id]) }),
          })
        )
      );
      setSelectedIds(new Set());
      await fetchAppointments();
    } catch (err) {
      setError(err.message || "Bulk approve failed.");
      showError(err.message || "Bulk approve failed.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleBulkCancel = async () => {
    const ids = Array.from(selectedIds);
    const reason = await showReasonPrompt(
      `Cancel ${ids.length} selected appointment${ids.length > 1 ? "s" : ""}? Please select a reason.`,
      "Cancel Appointments",
      "Cancel Appointments",
      STAFF_CANCEL_REASONS
    );
    if (!reason) return;
    setActionLoading(true);
    setError("");
    try {
      await Promise.all(
        ids.map((id) =>
          apiRequest(`/receptionist/requests/${id}/status`, {
            method: "PATCH",
            body: JSON.stringify({ status: "rejected", rejection_reason: reason }),
          })
        )
      );
      setSelectedIds(new Set());
      await fetchAppointments();
    } catch (err) {
      setError(err.message || "Bulk cancel failed.");
      showError(err.message || "Bulk cancel failed.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleReschedule = async (appointmentId, newDateTime) => {
    if (!appointmentId || !newDateTime) {
      setError("Choose an approved appointment and a new schedule before rescheduling.");
      showWarning("Choose an approved appointment and a new schedule before rescheduling.");
      return;
    }

    try {
      setActionLoading(true);
      await apiRequest(`/receptionist/appointments/${appointmentId}/reschedule`, {
        method: "POST",
        body: JSON.stringify({ scheduled_at: newDateTime }),
      });
      
      await fetchAppointments();
      setSelectedAppointment(null);
      setError("");
    } catch (err) {
      setError(err.message || "Failed to reschedule appointment");
      showError(err.message || "Failed to reschedule appointment");
    } finally {
      setActionLoading(false);
    }
  };

  const vetAppointments = appointments;

  const doctors = ["all", ...veterinarians.map(v => v.name)];

  const filteredAppointments = vetAppointments.filter(appointment => {
    const matchesSearch = 
      (appointment.petName || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      (appointment.owner || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      (appointment.doctor || "").toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesStatus = filterStatus === "all" || appointment.status === filterStatus;
    const matchesDoctor = filterDoctor === "all" || appointment.doctor === filterDoctor;
    
    return matchesSearch && matchesStatus && matchesDoctor;
  });

  const getStatusColor = (status) => {
    switch (status) {
      case "approved":
        return "info";
      case "pending":
        return "warning";
      case "completed":
        return "success";
      case "cancelled":
        return "danger";
      default:
        return "secondary";
    }
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case "approved":
        return faCheckCircle;
      case "pending":
        return faClock;
      case "completed":
        return faCheckCircle;
      case "cancelled":
        return faTimesCircle;
      default:
        return faClock;
    }
  };

  const getServiceIcon = (service) => {
    switch (service) {
      case "Vaccination":
        return faSyringe;
      case "Surgery":
        return faHeartbeat;
      case "Dental Cleaning":
        return faNotesMedical;
      default:
        return faStethoscope;
    }
  };

  const getUrgencyColor = (urgency) => {
    switch (urgency) {
      case "high":
        return "danger";
      case "medium":
        return "warning";
      case "low":
        return "success";
      default:
        return "secondary";
    }
  };

  return (
    <div className="vet-appointments">
      <div className="appointments-header">
        <div className="header-left">
          <h1>Veterinary Appointments</h1>
          <p>Manage veterinary appointments and patient scheduling</p>
        </div>
        <div className="header-actions">
          <button
            className="primary-btn"
            onClick={() => setShowServiceManager(true)}
          >
            <FontAwesomeIcon icon={faWrench} />
            Manage Services
          </button>
          <button className="primary-btn">
            <FontAwesomeIcon icon={faPlus} />
            New Appointment
          </button>
        </div>
      </div>

      {showServiceManager && (
        <ServiceManagerModal onClose={() => setShowServiceManager(false)} />
      )}

      {error && (
        <div className="error-banner">
          <FontAwesomeIcon icon={faExclamationTriangle} />
          <span>{error}</span>
        </div>
      )}

      {/* Summary Cards */}
      <div className="summary-cards">
        <div className="summary-card">
          <div className="card-icon">
            <FontAwesomeIcon icon={faCalendarAlt} />
          </div>
          <div className="card-content">
            <h3>{vetAppointments.length}</h3>
            <p>Total Appointments</p>
          </div>
        </div>
        <div className="summary-card">
          <div className="card-icon">
            <FontAwesomeIcon icon={faClock} />
          </div>
          <div className="card-content">
            <h3>{vetAppointments.filter(a => a.status === 'pending').length}</h3>
            <p>Pending</p>
          </div>
        </div>
        <div className="summary-card">
          <div className="card-icon">
            <FontAwesomeIcon icon={faCheckCircle} />
          </div>
          <div className="card-content">
            <h3>{vetAppointments.filter(a => a.status === 'approved').length}</h3>
            <p>Approved</p>
          </div>
        </div>
        <div className="summary-card">
          <div className="card-icon">
            <FontAwesomeIcon icon={faCheckCircle} />
          </div>
          <div className="card-content">
            <h3>{vetAppointments.filter(a => a.status === 'completed').length}</h3>
            <p>Completed Today</p>
          </div>
        </div>
        <div className="summary-card">
          <div className="card-icon">
            <FontAwesomeIcon icon={faCheckCircle} />
          </div>
          <div className="card-content">
            <h3>{vetAppointments.filter(a => a.status === 'completed').length}</h3>
            <p>Completed</p>
          </div>
        </div>
      </div>

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="bulk-action-bar">
          <span><FontAwesomeIcon icon={faTasks} /> <strong>{selectedIds.size}</strong> selected</span>
          <div className="bulk-actions">
            <button className="primary-btn" onClick={handleBulkApprove} disabled={actionLoading}>
              <FontAwesomeIcon icon={faCheckCircle} /> Approve Selected
            </button>
            <button className="secondary-btn" onClick={handleBulkCancel} disabled={actionLoading}>
              <FontAwesomeIcon icon={faTimesCircle} /> Cancel Selected
            </button>
            <button className="secondary-btn" onClick={() => setSelectedIds(new Set())} disabled={actionLoading}>
              <FontAwesomeIcon icon={faTimes} /> Clear
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="appointments-controls">
        <div className="search-filter-group">
          <div className="va-search-box">
            <input
              type="text"
              placeholder="Search by pet name, owner, or doctor..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="va-filter-dropdown">
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
            >
              <option value="all">All Status</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div className="va-filter-dropdown">
            <FontAwesomeIcon icon={faUserMd} />
            <select
              value={filterDoctor}
              onChange={(e) => setFilterDoctor(e.target.value)}
            >
              <option value="all">All Doctors</option>
              {doctors.map(doctor => (
                <option key={doctor} value={doctor}>{doctor}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Appointments Table */}
      <div className="appointments-table-container">
        <table className="appointments-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  onChange={selectAllVisible}
                  checked={
                    filteredAppointments.filter((a) => a.status === "pending").length > 0 &&
                    filteredAppointments.filter((a) => a.status === "pending").every((a) => selectedIds.has(a.rawId))
                  }
                  title="Select all pending"
                />
              </th>
              <th>Appointment ID</th>
              <th>Pet Info</th>
              <th>Owner</th>
              <th>Doctor</th>
              <th>Date & Time</th>
              <th>Service</th>
              <th>Status</th>
              <th>Urgency</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredAppointments.map((appointment) => (
              <tr key={appointment.id} className={`appointment-row ${selectedIds.has(appointment.rawId) ? "selected" : ""}`}>
                <td className="row-selection-spacer" />
                <td className="appointment-id">
                  <span className="id-badge">{appointment.id}</span>
                </td>
                <td className="pet-info">
                  <div className="pet-details">
                    <PetAvatar pet={appointment.pet} size={40} className="pet-avatar" />
                    <div>
                      <span className="pet-name">{appointment.petName}</span>
                      <span className="pet-breed">{appointment.breed}</span>
                      <span className="pet-type">{appointment.petType}</span>
                    </div>
                  </div>
                </td>
                <td className="owner">
                  <div className="owner-details">
                    <span className="owner-name">{appointment.owner}</span>
                    <span className="owner-phone">
                      <FontAwesomeIcon icon={faPhone} />
                      {appointment.ownerPhone}
                    </span>
                  </div>
                </td>
                <td className="doctor">
                  <div className="doctor-info">
                    <FontAwesomeIcon icon={faUserMd} />
                    <span>{appointment.doctor}</span>
                  </div>
                </td>
                <td className="datetime">
                  <div className="datetime-details">
                    <div className="date">
                      <FontAwesomeIcon icon={faCalendarAlt} />
                      {appointment.appointmentDate}
                    </div>
                    <div className="time">{appointment.appointmentTime}</div>
                    <div className="duration">{appointment.duration}</div>
                  </div>
                </td>
                <td className="service">
                  <div className="service-info">
                    <FontAwesomeIcon icon={getServiceIcon(appointment.service)} />
                    <span>{appointment.service}</span>
                  </div>
                </td>
                <td className="status">
                  <span className={`status-badge ${getStatusColor(appointment.status)}`}>
                    <FontAwesomeIcon icon={getStatusIcon(appointment.status)} />
                    {appointment.status}
                  </span>
                </td>
                <td className="urgency">
                  <span className={`urgency-badge ${getUrgencyColor(appointment.urgency)}`}>
                    {appointment.urgency}
                  </span>
                </td>
                <td className="actions">
                  <RowActionPopover rowLabel={appointment.petName}>
                    {appointment.status === "pending" && (
                      <label className="row-action-popover-checkbox">
                        <input
                          type="checkbox"
                          aria-label={`Select ${appointment.petName} for bulk actions`}
                          checked={selectedIds.has(appointment.rawId)}
                          onChange={() => toggleSelect(appointment.rawId)}
                        />
                        <span>Select for bulk actions</span>
                      </label>
                    )}
                    {appointment.status === "pending" ? (
                      <label className="row-action-popover-control">
                        <span>Assign veterinarian</span>
                        <select
                          aria-label={`Assign veterinarian to ${appointment.petName}`}
                          value={vetAssignments[appointment.rawId] || ""}
                          onChange={(event) => setVetAssignments((current) => ({
                            ...current,
                            [appointment.rawId]: event.target.value,
                          }))}
                        >
                          <option value="">{veterinarians.length ? "Choose vet" : "No active vets"}</option>
                          {veterinarians.map((vet) => <option key={vet.id} value={vet.id}>{vet.name}</option>)}
                        </select>
                      </label>
                    ) : (
                      <div className="row-action-popover-control"><span>Assigned veterinarian: {appointment.doctor}</span></div>
                    )}
                    {appointment.status === 'pending' && (
                    <button 
                      className="action-btn approve-btn" 
                      title="Approve"
                      onClick={() => handleApprove(appointment.rawId)}
                      disabled={actionLoading || veterinarians.length === 0}
                    >
                      <FontAwesomeIcon icon={faCheck} />
                    </button>
                  )}
                  <button 
                    className="action-btn view-btn"
                    onClick={() => setSelectedAppointment(appointment)}
                    title="View Details"
                  >
                    <FontAwesomeIcon icon={faEdit} />
                  </button>
                  {(appointment.status === 'pending' || appointment.status === 'approved') && (
                    <button 
                      className="action-btn delete-btn" 
                      title="Cancel"
                      onClick={() => handleCancel(appointment.rawId)}
                      disabled={actionLoading}
                    >
                      <FontAwesomeIcon icon={faTrash} />
                    </button>
                  )}
                  </RowActionPopover>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Appointment Details Modal */}
      {selectedAppointment && (
        <div className="hbk-overlay" onClick={() => setSelectedAppointment(null)}>
          <div className="hbk-modal" onClick={(e) => e.stopPropagation()}>
            <div className="hbk-head">
              <h2>Appointment Details</h2>
              <button
                className="close-btn"
                onClick={() => setSelectedAppointment(null)}
              >
                ×
              </button>
            </div>
            <div className="hbk-body">
              <div className="appointment-overview">
                <div className="overview-section">
                  <h3>Pet Information</h3>
                  <div className="info-grid">
                    <div className="info-item">
                      <label>Pet Name:</label>
                      <span>{selectedAppointment.petName}</span>
                    </div>
                    <div className="info-item">
                      <label>Type:</label>
                      <span>{selectedAppointment.petType}</span>
                    </div>
                    <div className="info-item">
                      <label>Breed:</label>
                      <span>{selectedAppointment.breed}</span>
                    </div>
                    <div className="info-item">
                      <label>Last Visit:</label>
                      <span>{selectedAppointment.previousVisit}</span>
                    </div>
                  </div>
                </div>
                
                <div className="overview-section">
                  <h3>Owner Information</h3>
                  <div className="info-grid">
                    <div className="info-item">
                      <label>Owner Name:</label>
                      <span>{selectedAppointment.owner}</span>
                    </div>
                    <div className="info-item">
                      <label>Phone:</label>
                      <span>{selectedAppointment.ownerPhone}</span>
                    </div>
                  </div>
                </div>
                
                <div className="overview-section">
                  <h3>Appointment Details</h3>
                  <div className="info-grid">
                    <div className="info-item">
                      <label>Doctor:</label>
                      <span>{selectedAppointment.doctor}</span>
                    </div>
                    <div className="info-item">
                      <label>Date:</label>
                      <span>{selectedAppointment.appointmentDate}</span>
                    </div>
                    <div className="info-item">
                      <label>Time:</label>
                      <span>{selectedAppointment.appointmentTime}</span>
                    </div>
                    <div className="info-item">
                      <label>Duration:</label>
                      <span>{selectedAppointment.duration}</span>
                    </div>
                    <div className="info-item">
                      <label>Service:</label>
                      <span>{selectedAppointment.service}</span>
                    </div>
                    <div className="info-item">
                      <label>Urgency:</label>
                      <span className={`urgency-badge ${getUrgencyColor(selectedAppointment.urgency)}`}>
                        {selectedAppointment.urgency}
                      </span>
                    </div>
                    <div className="info-item">
                      <label>Status:</label>
                      <span className={`status-badge ${getStatusColor(selectedAppointment.status)}`}>
                        <FontAwesomeIcon icon={getStatusIcon(selectedAppointment.status)} />
                        {selectedAppointment.status}
                      </span>
                    </div>
                  </div>
                </div>
                
                <div className="overview-section">
                  <h3>Medical Notes</h3>
                  <div className="notes-section">
                    <p>{selectedAppointment.notes}</p>
                  </div>
                </div>
              </div>
              
              <div className="hbk-foot">
                <button className="secondary-btn" onClick={() => setSelectedAppointment(null)}>
                  Close
                </button>
                <button className="primary-btn">
                  <FontAwesomeIcon icon={faEdit} />
                  Edit Appointment
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VetAppointments;
