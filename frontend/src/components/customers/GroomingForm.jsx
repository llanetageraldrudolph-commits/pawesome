import { useEffect, useState, useCallback } from "react";
import "./GroomingForm.css";
import { apiRequest, normalizeList } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { getDraft, clearDraft } from "../../utils/preBookingDraft";
import DatePickerInput from "../../components/shared/DatePickerInput";
import { formatDateOnly, parseDateOnly } from "../../utils/date";
import {
  validateServiceCompatibility,
  getUnavailableServiceMessage,
} from "../../config/petServiceRules";
import { showAlert, showSuccess, showError, showConfirm, showReasonPrompt, CUSTOMER_CANCEL_REASONS } from "../../utils/alert.jsx";
import BookingReviewModal from "../shared/BookingReviewModal";

const GROOMING_TIME_SLOTS = Array.from({ length: 8 }, (_, index) => {
  const hour = index + 10;
  const value = `${String(hour).padStart(2, "0")}:00`;
  const displayHour = hour % 12 || 12;
  return {
    value,
    label: `${displayHour}:00 ${hour < 12 ? "AM" : "PM"}`,
  };
});

const GroomingForm = () => {
  const { user } = useAuth();
  const customerEmail = user?.email;
  const customerName = user?.name || "Customer";

  const [activeTab, setActiveTab] = useState("book");
  const [appointments, setAppointments] = useState([]);
  const [pets, setPets] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [groomingAvailability, setGroomingAvailability] = useState(null);
  const [availableTimeSlots, setAvailableTimeSlots] = useState([]);
  const [dateAvailable, setDateAvailable] = useState(true);

  const [formData, setFormData] = useState({
    customer_name: customerName,
    customer_email: customerEmail || "",
    pet_id: "",
    pet_name: "",
    service_type: "grooming",
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
      const groomingOnly = requests.filter(
        (item) =>
          item.type === "grooming" ||
          item.request_type === "grooming" ||
          (item.service_name && String(item.service_name).toLowerCase().includes("groom"))
      );
      setAppointments(groomingOnly);
    } catch (error) {
      console.error("Failed to load grooming appointments:", error);
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
    if (!draft || draft.service_type !== "grooming") return;

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
    if (draft.form_data?.grooming_service_type) updates.service_name = draft.form_data.grooming_service_type;
    if (draft.form_data?.preferred_date) updates.request_date = draft.form_data.preferred_date;
    if (GROOMING_TIME_SLOTS.some((slot) => slot.value === draft.form_data?.preferred_time)) {
      updates.request_time = draft.form_data.preferred_time;
    }
    if (draft.form_data?.special_grooming_instructions) updates.notes = draft.form_data.special_grooming_instructions;

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
    ? validateServiceCompatibility(selectedPet.species || selectedPet.type, "grooming")
    : null;
  const typeMessage = selectedPet && compatibility && !compatibility.isValid
    ? compatibility.message || getUnavailableServiceMessage(selectedPet.species || selectedPet.type, "grooming")
    : "";

  const fetchGroomingAvailability = async (date, serviceName = formData.service_name) => {
    try {
      setAvailabilityLoading(true);
      const query = new URLSearchParams({ date });
      if (serviceName) query.set("service_name", serviceName);
      const data = await apiRequest(`/customer/availability/grooming?${query}`);

      if (data.success) {
        const slots = data.slots || [];
        setGroomingAvailability(data);
        setAvailableTimeSlots(slots);
        setDateAvailable(data.available);
        setFormData((prev) => slots.some((slot) => slot.time === prev.request_time && slot.available)
          ? prev
          : { ...prev, request_time: "" });
      } else {
        setGroomingAvailability(null);
        setAvailableTimeSlots([]);
        setDateAvailable(false);
      }
    } catch (error) {
      console.error("Error fetching grooming availability:", error);
      setGroomingAvailability(null);
      setAvailableTimeSlots([]);
      setDateAvailable(false);
      showError("Failed to check availability. Please try again.");
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
      if (formData.request_date) fetchGroomingAvailability(formData.request_date, value);
      return;
    }

    setFormData((prev) => ({ ...prev, [name]: value, ...(name === "request_date" ? { request_time: "" } : {}) }));

    if (name === "request_date" && value) {
      fetchGroomingAvailability(value);
    }
  };

  const [reviewOpen, setReviewOpen] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();

    if (!formData.pet_id) {
      showAlert("Please select an active pet for this grooming appointment.");
      return;
    }

    if (compatibility && !compatibility.isValid) {
      showAlert(typeMessage || "This service is not available for this pet type.");
      return;
    }

    if (!dateAvailable || !availableTimeSlots.some((slot) => slot.time === formData.request_time && slot.available)) {
      showAlert("That grooming time is no longer available. Please choose another available slot.");
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
        showSuccess("Grooming appointment submitted! Waiting for receptionist approval.");

        setFormData({
          customer_name: customerName,
          customer_email: customerEmail || "",
          pet_id: "",
          pet_name: "",
          service_type: "grooming",
          service_name: "",
          price: "",
          request_date: "",
          request_time: "",
          notes: "",
        });

        setGroomingAvailability(null);
        setAvailableTimeSlots([]);
        setDateAvailable(true);

        await fetchAppointments();
        setActiveTab("my");
      } else {
        showAlert(data.message || "Failed to submit grooming appointment");
      }
    } catch (error) {
      console.error("Submit error:", error);
      showError(error.message || "Failed to submit grooming appointment");
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
    <section className="grooming-container">
      <div className="grooming-header">
        <h1>Pet Grooming</h1>
      </div>

      <div className="grooming-tabs">
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
        <div className="grooming-card">
          <h2>Grooming Appointment Form</h2>

          <form className="grooming-form" onSubmit={handleSubmit}>
            <input
              type="text"
              name="customer_name"
              placeholder="Customer Name"
              value={formData.customer_name}
              onChange={handleChange}
              required
              readOnly
              style={{ backgroundColor: "#f0f0f0" }}
            />

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
              <div className="grooming-selected-pet-info">
                <p><strong>Type of Pet:</strong> {petDisplayInfo.typeOfPet}</p>
                {petDisplayInfo.birthdate && (
                  <p><strong>Birthdate:</strong> {new Date(petDisplayInfo.birthdate).toLocaleDateString()}</p>
                )}
                {petDisplayInfo.age && (
                  <p><strong>Age:</strong> {petDisplayInfo.age}</p>
                )}
              </div>
            )}

            {typeMessage && (
              <div className="no-availability">
                <span>⚠</span>
                <span>{typeMessage}</span>
              </div>
            )}

            <select
              name="service_name"
              value={formData.service_name}
              onChange={handleChange}
              required
            >
              <option value="">Select a grooming service...</option>
              {services
                .filter((s) => ["grooming", "daycare"].includes((s.category || "").toLowerCase()))
                .map((service) => (
                  <option key={service.id || service.name} value={service.name}>
                    {service.name}
                    {service.price ? ` \u2014 \u20b1${Number(service.price).toFixed(2)}` : ""}
                  </option>
                ))}
            </select>
            {services.length === 0 && (
              <small className="service-loading">Loading services...</small>
            )}

            <DatePickerInput
              selected={parseDateOnly(formData.request_date)}
              onChange={(date) =>
                handleChange({
                  target: {
                    name: "request_date",
                    value: formatDateOnly(date),
                  },
                })
              }
              placeholderText="mm/dd/yyyy"
              minDate={new Date()}
              required
            />

            {/* Availability Display */}
            {groomingAvailability && (
              <div className="grooming-availability">
                {dateAvailable ? (
                  <div className="availability-success">
                    <span>✓</span>
                    <span>This grooming date is available for booking.</span>
                  </div>
                ) : (
                  <div className="no-availability">
                    <span>⚠</span>
                    <span>This grooming date is already reserved. Please choose another date.</span>
                    {groomingAvailability.existing_appointment && (
                      <div className="existing-booking">
                        <small>Existing booking: {groomingAvailability.existing_appointment.pet_name} - {groomingAvailability.existing_appointment.service}</small>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {availabilityLoading && (
              <div className="availability-loading">
                <span>Checking availability...</span>
              </div>
            )}

            <label htmlFor="grooming-request-time">Appointment Time *</label>
            <select
              id="grooming-request-time"
              name="request_time"
              value={formData.request_time}
              onChange={handleChange}
              disabled={!formData.request_date || availabilityLoading || !dateAvailable}
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
              placeholder="Notes or special instructions"
              value={formData.notes}
              onChange={handleChange}
            />

            {formData.price !== "" && (
              <div className="grooming-price-summary">
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
        <div className="grooming-card">
          {appointments.length === 0 ? (
            <p>No grooming appointments yet.</p>
          ) : (
            appointments.map((item) => (
              <div key={item.id} className="grooming-item">
                <h3>{item.pet}</h3>
                <p>Service: {item.service}</p>
                <p>Date: {item.date}</p>
                <p>Time: {item.time}</p>
                <p>Notes: {item.notes || "None"}</p>
                {(item.price || item.amount) && (
                  <p className="grooming-price">
                    Price: ₱{Number(item.price || item.amount).toFixed(2)}
                  </p>
                )}

                <span className={`status ${item.status}`}>
                  {item.status}
                </span>

                {(item.status === "pending" || item.status === "submitted") && (
                  <button
                    className="grooming-cancel-btn"
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
        badge="Grooming"
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
          rows: [{ label: formData.service_name || "Grooming service", value: `₱${Number(formData.price).toFixed(2)}` }],
          total: `₱${Number(formData.price).toFixed(2)}`,
        } : null}
        notes={formData.notes}
      />
    </section>
  );
};

export default GroomingForm;
