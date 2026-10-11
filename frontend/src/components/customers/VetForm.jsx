import { useEffect, useState, useCallback } from "react";
import "./VetForm.css";
import { apiRequest, normalizeList } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { getDraft, clearDraft } from "../../utils/preBookingDraft";
import DatePickerInput from "../../components/shared/DatePickerInput";
import { formatDateOnly, parseDateOnly } from "../../utils/date";
import {
  validateServiceCompatibility,
  getSpecialCareWarning,
} from "../../config/petServiceRules";
import { BUSINESS_HOURS, TIME_SLOT_INTERVAL } from "../../config/serviceDurationRules";
import { showAlert, showSuccess, showError, showConfirm, showReasonPrompt, CUSTOMER_CANCEL_REASONS } from "../../utils/alert.jsx";
import BookingReviewModal from "../shared/BookingReviewModal";

const VET_TIME_SLOTS = (() => {
  const slots = [];
  const [startHour, startMinute] = BUSINESS_HOURS.start.split(":").map(Number);
  const [endHour, endMinute] = BUSINESS_HOURS.end.split(":").map(Number);
  const cursor = new Date();
  cursor.setHours(startHour, startMinute, 0, 0);
  const end = new Date();
  end.setHours(endHour, endMinute, 0, 0);
  while (cursor < end) {
    const value = cursor.toTimeString().slice(0, 5);
    const label = cursor.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", hour12: true });
    slots.push({ value, label });
    cursor.setMinutes(cursor.getMinutes() + TIME_SLOT_INTERVAL);
  }
  return slots;
})();

const VetForm = () => {
  const { user } = useAuth();
  const customerEmail = user?.email;
  const customerName = user?.name || "Customer";

  const [activeTab, setActiveTab] = useState("book");
  const [appointments, setAppointments] = useState([]);
  const [pets, setPets] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [availableTimeSlots, setAvailableTimeSlots] = useState([]);

  const [formData, setFormData] = useState({
    customer_name: customerName,
    customer_email: customerEmail || "",
    pet_id: "",
    pet_name: "",
    service_type: "vet",
    service_name: "",
    price: "",
    request_date: "",
    request_time: "",
    notes: "",
  });

  const fetchAppointments = useCallback(async () => {
    try {
      const data = await apiRequest("/customer/my-requests");
      const requests = normalizeList(data, ["requests", "data"]);
      const vetOnly = requests.filter(
        (item) =>
          item.type === "vet" ||
          item.request_type === "vet" ||
          (item.service_name && String(item.service_name).toLowerCase().includes("vet"))
      );
      setAppointments(vetOnly);
    } catch (error) {
      console.error("Failed to load vet appointments:", error);
      setAppointments([]);
    }
  }, []);

  const fetchPets = useCallback(async () => {
    try {
      const data = await apiRequest("/customer/pets");
      const activePets = normalizeList(data, ["pets", "data"]).filter(
        (pet) => pet.status !== "archived" && !pet.archived_at
      );
      setPets(activePets);
    } catch (error) {
      console.error("Failed to load pets:", error);
      setPets([]);
    }
  }, []);

  const fetchServices = useCallback(async () => {
    try {
      const data = await apiRequest("/customer/services");
      const list = normalizeList(data, ["services", "data"]);
      setServices(list);
    } catch (error) {
      console.error("Failed to load services:", error);
      setServices([]);
    }
  }, []);

  useEffect(() => {
    fetchAppointments();
    fetchPets();
    fetchServices();
  }, [fetchAppointments, fetchPets, fetchServices]);

  useEffect(() => {
    const draft = getDraft();
    if (!draft || draft.service_type !== "vet") return;

    const updates = {};
    if (draft.form_data?.pet_id && pets.some((p) => String(p.id) === String(draft.form_data.pet_id))) {
      const pet = pets.find((p) => String(p.id) === String(draft.form_data.pet_id));
      updates.pet_id = pet.id;
      updates.pet_name = pet.name;
    }
    if (!updates.pet_id && draft.form_data?.pet_name) updates.pet_name = draft.form_data.pet_name;
    if (!updates.pet_id && draft.form_data?.pet_type) {
      const pet = pets.find((p) => (p.species || p.type || "").toLowerCase() === (draft.form_data.pet_type || "").toLowerCase());
      if (pet) { updates.pet_id = pet.id; updates.pet_name = pet.name; }
    }
    if (draft.form_data?.veterinary_service_type) updates.service_name = draft.form_data.veterinary_service_type;
    if (draft.form_data?.preferred_date) updates.request_date = draft.form_data.preferred_date;
    if (VET_TIME_SLOTS.some((slot) => slot.value === draft.form_data?.preferred_time)) {
      updates.request_time = draft.form_data.preferred_time;
    }
    if (draft.form_data?.main_reason_for_visit) updates.notes = draft.form_data.main_reason_for_visit;

    setFormData((prev) => ({ ...prev, ...updates }));
    clearDraft();

    if (Object.keys(updates).length > 0) {
      showSuccess("We have restored your booking details. Please review and submit.");
    }
  }, [pets]);

  const selectedPet = pets.find((pet) => String(pet.id) === String(formData.pet_id));

  const calculateAge = (birthdate) => {
    if (!birthdate) return null;
    const today = new Date();
    const birth = new Date(birthdate);
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--;
    }
    if (age <= 0) return "Less than 1 year";
    return `${age} year${age > 1 ? "s" : ""}`;
  };

  const getPetDisplayInfo = (pet) => {
    if (!pet) return null;
    const typeOfPet = pet.species || pet.type || "Pet";
    const birthdate = pet.birthdate || pet.birth_date || pet.date_of_birth;
    const age = calculateAge(birthdate);
    return {
      typeOfPet,
      birthdate,
      age,
    };
  };

  const petDisplayInfo = getPetDisplayInfo(selectedPet);

  const compatibility = selectedPet
    ? validateServiceCompatibility(selectedPet.species || selectedPet.type, "veterinary")
    : null;
  const serviceMessage = selectedPet
    ? getSpecialCareWarning(selectedPet.species || selectedPet.type, "veterinary")
    : "";

  const fetchVetAvailability = async (date, serviceName = formData.service_name) => {
    if (!date) {
      setAvailableTimeSlots([]);
      return;
    }

    setAvailabilityLoading(true);
    try {
      const query = new URLSearchParams({ date });
      if (serviceName) query.set("service_name", serviceName);
      const data = await apiRequest(`/customer/availability/veterinary?${query}`);
      const slots = data.slots || [];
      setAvailableTimeSlots(slots);
      setFormData((prev) => slots.some((slot) => slot.time === prev.request_time && slot.available)
        ? prev
        : { ...prev, request_time: "" });
    } catch (error) {
      setAvailableTimeSlots([]);
      showError(error.message || "Failed to check appointment availability.");
    } finally {
      setAvailabilityLoading(false);
    }
  };

  const handleChange = (e) => {
    const { name, value } = e.target;

    if (name === "pet_id") {
      const pet = pets.find((item) => String(item.id) === String(value));
      setFormData((prev) => ({
        ...prev,
        pet_id: value,
        pet_name: pet?.name || "",
      }));
      return;
    }

    if (name === "service_name") {
      const service = services.find((s) => s.name === value);
      setFormData((prev) => ({
        ...prev,
        service_name: value,
        price: service?.price ?? "",
        request_time: "",
      }));
      if (formData.request_date) fetchVetAvailability(formData.request_date, value);
      return;
    }

    setFormData((prev) => ({ ...prev, [name]: value, ...(name === "request_date" ? { request_time: "" } : {}) }));
  };

  const [reviewOpen, setReviewOpen] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();

    if (!formData.pet_id) {
      showAlert("Please select an active pet for this appointment.");
      return;
    }

    if (compatibility && !compatibility.isValid) {
      showAlert(compatibility.message || "This service is not available for this pet type.");
      return;
    }

    if (!availableTimeSlots.some((slot) => slot.time === formData.request_time && slot.available)) {
      showAlert("That appointment time is no longer available. Please choose another slot.");
      return;
    }

    setReviewOpen(true);
  };

  const confirmBooking = async () => {
    try {
      setLoading(true);

      const data = await apiRequest("/customer/requests", {
        method: "POST",
        body: JSON.stringify(formData),
      });

      if (data.success) {
        setReviewOpen(false);
        showSuccess("Vet appointment submitted! Waiting for receptionist approval.");

        setFormData({
          customer_name: customerName,
          customer_email: customerEmail || "",
          pet_id: "",
          pet_name: "",
          service_type: "vet",
          service_name: "",
          price: "",
          request_date: "",
          request_time: "",
          notes: "",
        });
        setAvailableTimeSlots([]);

        await fetchAppointments();
        setActiveTab("my");
      } else {
        showAlert(data.message || "Failed to submit vet appointment");
      }
    } catch (error) {
      showError(error.message || "Failed to submit vet appointment");
    } finally {
      setLoading(false);
    }
  };

  const cancelRequest = async (item) => {
    const reason = await showReasonPrompt(
      "Cancel this appointment? Please select a reason — it will be recorded.",
      "Cancel Appointment",
      "Yes, Cancel",
      CUSTOMER_CANCEL_REASONS
    );
    if (reason === null) return;
    try {
      await apiRequest(`/customer/requests/${item.id}/cancel`, "PATCH", { reason });
      showSuccess("Appointment cancelled.");
      fetchAppointments();
    } catch (err) {
      showError(err.message || "Failed to cancel appointment.");
    }
  };

  return (
    <section className="vet-container">
      <div className="vet-header">
        <h1>Veterinary Appointment</h1>
      </div>

      <div className="vet-tabs">
        <button
          className={activeTab === "book" ? "active" : ""}
          onClick={() => setActiveTab("book")}
        >
          New Appointment
        </button>

        <button
          className={activeTab === "my" ? "active" : ""}
          onClick={() => setActiveTab("my")}
        >
          My Appointments ({appointments.length})
        </button>
      </div>

      {activeTab === "book" && (
        <div className="vet-card">
          <h2>Vet Appointment Form</h2>

          <form className="vet-form" onSubmit={handleSubmit}>
            <select
              name="pet_id"
              value={formData.pet_id}
              onChange={handleChange}
              required
            >
              <option value="">Select active pet</option>
              {pets.map((pet) => {
                const info = getPetDisplayInfo(pet);
                return (
                  <option key={pet.id} value={pet.id}>
                    {pet.name} — {info?.typeOfPet || "Pet"}
                    {info?.age ? ` (${info.age})` : ""}
                  </option>
                );
              })}
            </select>

            {selectedPet && petDisplayInfo && (
              <div className="vet-selected-pet-info">
                <p><strong>Type of Pet:</strong> {petDisplayInfo.typeOfPet}</p>
                {petDisplayInfo.birthdate && (
                  <p><strong>Birthdate:</strong> {new Date(petDisplayInfo.birthdate).toLocaleDateString()}</p>
                )}
                {petDisplayInfo.age && (
                  <p><strong>Age:</strong> {petDisplayInfo.age}</p>
                )}
              </div>
            )}

            {selectedPet && serviceMessage && (
              <div className="vet-service-note">{serviceMessage}</div>
            )}

            {selectedPet && compatibility && !compatibility.isValid && (
              <div className="vet-service-note error">
                {compatibility.message || "This service is not available for this pet type."}
              </div>
            )}

            <select
              name="service_name"
              value={formData.service_name}
              onChange={handleChange}
              required
            >
              <option value="">Select a service...</option>
              {services
                .filter((s) => {
                  const cat = (s.category || s.service_type || s.type || "").toLowerCase();
                  return [
                    "vet",
                    "veterinary",
                    "veterinary_service",
                    "consultation",
                    "vaccination",
                    "treatment",
                    "emergency",
                    "surgery",
                    "dental",
                    "diagnostics",
                    "medication",
                  ].includes(cat) || cat.includes("vet");
                })
                .map((service) => (
                  <option key={service.id} value={service.name}>
                    {service.name}
                    {service.category ? ` (${service.category})` : ""}
                    {service.price ? ` — ₱${Number(service.price).toFixed(2)}` : ""}
                  </option>
                ))}
            </select>

            <DatePickerInput
              selected={parseDateOnly(formData.request_date)}
              onChange={(date) => {
                const value = formatDateOnly(date);
                setFormData((prev) => ({ ...prev, request_date: value, request_time: "" }));
                fetchVetAvailability(value);
              }}
              placeholderText="mm/dd/yyyy"
              minDate={new Date()}
              required
            />

            {availabilityLoading && <p role="status">Checking available times...</p>}
            <select
              name="request_time"
              value={formData.request_time}
              onChange={handleChange}
              disabled={!formData.request_date || !formData.service_name || availabilityLoading}
              required
            >
              <option value="">Select an available time</option>
              {availableTimeSlots.map((slot) => (
                <option key={slot.time} value={slot.time} disabled={!slot.available}>
                  {slot.label}{slot.available ? "" : " (Unavailable)"}
                </option>
              ))}
            </select>

            <textarea
              name="notes"
              placeholder="Describe pet concern or symptoms"
              value={formData.notes}
              onChange={handleChange}
              required
            />

            {formData.price !== "" && (
              <div className="vet-price-summary">
                <strong>Estimated Price:</strong> ₱{Number(formData.price).toFixed(2)}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || (compatibility && !compatibility.isValid)}
            >
              {loading ? "Submitting..." : "Submit Request"}
            </button>
          </form>
        </div>
      )}

      {activeTab === "my" && (
        <div className="vet-card">
          {appointments.length === 0 ? (
            <p>No vet appointments yet.</p>
          ) : (
            appointments.map((item) => (
              <div key={item.id} className="vet-item">
                <h3>{item.pet_name}</h3>
                <p>Service: {item.service_name}</p>
                <p>Date: {item.request_date}</p>
                <p>Time: {item.request_time}</p>
                <p>Concern: {item.notes || "None"}</p>
                {(item.price || item.amount) && (
                  <p className="vet-price">
                    Price: ₱{Number(item.price || item.amount).toFixed(2)}
                  </p>
                )}

                <span className={`vet-status ${item.status}`}>
                  {item.status}
                </span>

                {(item.status === "pending" || item.status === "submitted") && (
                  <button
                    className="vet-cancel-btn"
                    onClick={() => cancelRequest(item)}
                    style={{ marginTop: "0.5rem", background: "#ef4444", color: "#fff", border: "none", borderRadius: "6px", padding: "0.4rem 0.8rem", cursor: "pointer", fontSize: "0.85rem", fontWeight: 600 }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      <BookingReviewModal
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        onConfirm={confirmBooking}
        loading={loading}
        badge="Veterinary"
        pet={selectedPet ? {
          name: selectedPet.name,
          species: selectedPet.species || selectedPet.type,
          breed: selectedPet.breed,
          age: petDisplayInfo?.age,
        } : null}
        details={[
          { label: "Service", value: formData.service_name },
          { label: "Date", value: formData.request_date && new Date(`${formData.request_date}T00:00:00`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) },
          { label: "Time", value: formData.request_time },
        ]}
        pricing={formData.price !== "" ? {
          rows: [{ label: formData.service_name || "Veterinary service", value: `₱${Number(formData.price).toFixed(2)}` }],
          total: `₱${Number(formData.price).toFixed(2)}`,
        } : null}
        notes={formData.notes}
      />
    </section>
  );
};

export default VetForm;
