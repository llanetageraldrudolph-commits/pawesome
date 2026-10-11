import React, { useEffect, useMemo, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faPlus,
  faSpinner,
  faTimes,
} from "@fortawesome/free-solid-svg-icons";
import { apiRequest } from "../../../api/client";
import DatePickerInput from "../../shared/DatePickerInput";
import BookingReviewModal from "../../shared/BookingReviewModal";
import { formatDateOnly, parseDateOnly } from "../../../utils/date";
import "../../../styles/bookingModal.css";
import "./NewWalkInBookingModal.css";

const initialForm = {
  customerId: "",
  petId: "",
  ownerName: "",
  petName: "",
  petType: "",
  breed: "",
  appointmentDate: "",
  appointmentTime: "10:00",
  service: "",
  duration: "1 day",
  roomType: "Standard Room",
  symptoms: "",
  medicalNotes: "",
  specialRequests: "",
  bookingType: "hotel",
  paymentMethod: "cash",
  paidAmount: "0",
  vaccinationCard: null,
};

const roomRates = {
  "Standard Room": 50,
  "Deluxe Suite": 80,
  "Presidential Suite": 120,
};

const safeArray = (data, key) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.[key])) return data.data[key];
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data?.items)) return data.items;
  return [];
};

const formatCurrency = (value) => {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
  }).format(amount);
};

const getPaymentStatusFromAmount = (amount, paid) => {
  const total = Number(amount || 0);
  const paidAmt = Number(paid || 0);
  if (paidAmt >= total && total > 0) return "paid";
  if (paidAmt > 0 && paidAmt < total) return "partial";
  return "pending";
};

const combineDateTime = (date, time) => {
  if (!date || !time) return date;
  const d = new Date(date);
  const [h, m] = String(time).split(":");
  d.setHours(Number(h || 0), Number(m || 0), 0, 0);
  return d.toISOString();
};

const NewWalkInBookingModal = ({ onClose, onSuccess }) => {
  const [form, setForm] = useState(initialForm);
  const [customers, setCustomers] = useState([]);
  const [pets, setPets] = useState([]);
  const [services, setServices] = useState([]);
  const [hotelRooms, setHotelRooms] = useState([]);
  const roomsRequestRef = useRef(0);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const [cData, pData, sData, hData] = await Promise.all([
          apiRequest("/customers").catch(() => null),
          apiRequest("/pets").catch(() => null),
          apiRequest("/services").catch(() => null),
          apiRequest("/receptionist/hotel-rooms?status=available").catch(() => null),
        ]);
        setCustomers(safeArray(cData, "customers"));
        setPets(safeArray(pData, "pets"));
        setServices(safeArray(sData, "services"));
        // Don't overwrite a date-specific room list if the user already
        // picked a date while this initial load was in flight.
        if (roomsRequestRef.current === 0) {
          setHotelRooms(safeArray(hData, "rooms").filter((r) => !r.status || r.status === "available"));
        }
      } catch {
        setCustomers([]);
        setPets([]);
        setServices([]);
        setHotelRooms([]);
      }
    };
    load();
  }, []);

  // Refresh room availability when the booking date changes
  useEffect(() => {
    if (form.bookingType !== "hotel" || !form.appointmentDate) return;
    const requestId = ++roomsRequestRef.current;
    apiRequest(`/receptionist/hotel-rooms?date=${encodeURIComponent(form.appointmentDate)}`)
      .then((hData) => {
        if (requestId === roomsRequestRef.current) {
          setHotelRooms(safeArray(hData, "rooms"));
        }
      })
      .catch(() => {});
  }, [form.appointmentDate, form.bookingType]);

  const vetServices = useMemo(() => {
    return services.filter((service) => {
      const category = String(service.category || "").toLowerCase();
      return !category.includes("groom") && !category.includes("boarding") && !category.includes("hotel");
    });
  }, [services]);

  const groomingServices = useMemo(() => {
    return services.filter((service) =>
      String(service.category || "").toLowerCase().includes("groom")
    );
  }, [services]);

  const selectedService = useMemo(() => {
    return services.find(
      (service) =>
        String(service.id) === String(form.service) ||
        String(service.name) === String(form.service)
    );
  }, [services, form.service]);

  const calculatedAmount = useMemo(() => {
    if (form.bookingType === "hotel") {
      const dailyRate = roomRates[form.roomType] || roomRates["Standard Room"];
      return dailyRate; // same-day stay: one day rate
    }
    if (selectedService) {
      return Number(selectedService.price || selectedService.amount || 0);
    }
    return 0;
  }, [form.bookingType, form.roomType, form.duration, selectedService]);

  const vaccinationPreview = useMemo(() => {
    const f = form.vaccinationCard;
    return f && f.type?.startsWith("image/") ? URL.createObjectURL(f) : null;
  }, [form.vaccinationCard]);

  useEffect(() => {
    return () => { if (vaccinationPreview) URL.revokeObjectURL(vaccinationPreview); };
  }, [vaccinationPreview]);

  const handleInputChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => {
      if (name === "bookingType") {
        return { ...prev, bookingType: value, service: "" };
      }
      return { ...prev, [name]: value };
    });
  };

  const handleCustomerChange = (customerId) => {
    const customer = customers.find((item) => String(item.id) === String(customerId));
    if (customer) {
      setForm((prev) => ({
        ...prev,
        customerId,
        petId: "",
        ownerName: customer.name || customer.full_name || "",
      }));
    } else {
      setForm((prev) => ({ ...prev, customerId, petId: "", ownerName: "" }));
    }
  };

  const handlePetChange = (petId) => {
    const pet = pets.find((item) => String(item.id) === String(petId));
    if (pet) {
      setForm((prev) => ({
        ...prev,
        petId,
        petName: pet.name || "",
        petType: pet.type || pet.species || "",
        breed: pet.breed || "",
      }));
    } else {
      setForm((prev) => ({ ...prev, petId, petName: "", petType: "", breed: "" }));
    }
  };

  const getAvailablePets = () => {
    if (!form.customerId) return [];
    return pets.filter(
      (pet) =>
        String(pet.customer_id || pet.customerId || pet.owner_id || pet.user_id) ===
        String(form.customerId)
    );
  };

  // Helper to resolve room type to actual hotel_room_id
  const resolveHotelRoomId = (roomTypeName) => {
    // Try to find a room that matches the type
    const room = hotelRooms.find((r) =>
      String(r.type || r.room_type || "").toLowerCase() === String(roomTypeName).toLowerCase() ||
      String(r.name || "").toLowerCase().includes(String(roomTypeName).toLowerCase())
    );
    return room?.id || roomTypeName; // Fallback to name if no match
  };

  // Helper to build notes from various fields
  const buildNotes = () => {
    const parts = [];
    if (form.specialRequests) parts.push(`Special Requests: ${form.specialRequests}`);
    if (form.symptoms) parts.push(`Symptoms: ${form.symptoms}`);
    if (form.medicalNotes) parts.push(`Medical Notes: ${form.medicalNotes}`);
    return parts.join("\n") || "";
  };

  // Vaccination card is optional for hotel bookings
  const handleSubmit = (event) => {
    event.preventDefault();
    if (!form.customerId || !form.petId || !form.appointmentDate) {
      setError("Please select a customer, pet, and appointment date.");
      return;
    }
    if (form.bookingType !== "hotel" && !form.service) {
      setError("Please select a service.");
      return;
    }
    setReviewOpen(true);
  };

  const confirmBooking = async () => {
    try {
      setProcessing(true);
      setError("");
      const amount = calculatedAmount;
      const paidAmount = Number(form.paidAmount || 0);

      let endpoint = "";
      let payload = {};
      let useFormData = false;

      if (form.bookingType === "hotel") {
        endpoint = "/boardings";
        const hotelRoomId = resolveHotelRoomId(form.roomType);

        // Use FormData for file upload
        useFormData = true;
        payload = new FormData();
        payload.append("pet_id", form.petId);
        payload.append("customer_id", form.customerId);
        payload.append("hotel_room_id", hotelRoomId);
        payload.append("check_in_date", form.appointmentDate);
        payload.append("number_of_days", "1"); // same-day stay (9 AM - 7 PM)
        payload.append("notes", buildNotes());
        if (form.vaccinationCard) {
          payload.append("vaccination_card", form.vaccinationCard);
        }
        // Optional fields
        if (paidAmount > 0) {
          payload.append("paid_amount", paidAmount);
          payload.append("payment_method", form.paymentMethod);
        }
      }

      if (form.bookingType === "vet") {
        endpoint = "/receptionist/appointments";
        payload = {
          customer_id: form.customerId,
          pet_id: form.petId,
          service_id: form.service,
          scheduled_at: combineDateTime(form.appointmentDate, form.appointmentTime),
          notes: buildNotes(),
          // Backend auto-fetches price from service
        };
      }

      if (form.bookingType === "grooming") {
        endpoint = "/grooming";
        // Get service name from selected service_id
        const selectedService = services.find((s) => String(s.id) === String(form.service));
        const serviceName = selectedService?.name || form.service;

        payload = {
          customer_id: form.customerId,
          pet_id: form.petId,
          service: serviceName, // Backend expects service NAME, not ID
          appointment_date: form.appointmentDate,
          appointment_time: form.appointmentTime,
          amount: amount, // Backend expects amount, not price
          notes: form.specialRequests, // Backend expects notes, not special_requests
        };
      }

      const requestOptions = {
        method: "POST",
        body: useFormData ? payload : JSON.stringify(payload),
      };

      // Don't set Content-Type for FormData - browser will set it with boundary
      if (!useFormData) {
        requestOptions.headers = { "Content-Type": "application/json" };
      }

      await apiRequest(endpoint, requestOptions);

      setReviewOpen(false);
      setForm(initialForm);
      onSuccess();
    } catch (err) {
      setError(err.message || "Failed to create booking. Please try again.");
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="hbk-overlay" onClick={onClose}>
      <div className="hbk-modal hbk-booking-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hbk-head">
          <div>
            <span className="hbk-eyebrow">
              <FontAwesomeIcon icon={faPlus} />
              Walk-in Transaction
            </span>
            <h2>New Booking</h2>
          </div>
          <button type="button" className="close-btn" onClick={onClose} disabled={processing}>
            <FontAwesomeIcon icon={faTimes} />
          </button>
        </div>

        <div className="hbk-body">
          {error && <div className="hbk-error">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="hub-form-section">
              <h4>Customer &amp; Pet Information</h4>
              <div className="hub-form-grid">
                <div className="hub-form-group">
                  <label>Booking Type *</label>
                  <select name="bookingType" value={form.bookingType} onChange={handleInputChange} required>
                    <option value="hotel">Hotel</option>
                    <option value="vet">Veterinary</option>
                    <option value="grooming">Grooming</option>
                  </select>
                </div>

                <div className="hub-form-group">
                  <label>Select Customer *</label>
                  <select
                    name="customerId"
                    value={form.customerId}
                    onChange={(e) => handleCustomerChange(e.target.value)}
                    required
                  >
                    <option value="">Choose a customer...</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.name || customer.full_name || "Customer"} ({customer.phone || "No phone"})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="hub-form-group">
                  <label>Select Pet *</label>
                  <select
                    name="petId"
                    value={form.petId}
                    onChange={(e) => handlePetChange(e.target.value)}
                    required
                    disabled={!form.customerId}
                  >
                    <option value="">
                      {form.customerId ? "Choose a pet..." : "Select customer first"}
                    </option>
                    {getAvailablePets().map((pet) => (
                      <option key={pet.id} value={pet.id}>
                        {pet.name} ({pet.type || pet.species || "Pet"} - {pet.breed || "Unknown breed"})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="hub-form-group">
                  <label>Pet Name</label>
                  <input value={form.petName} disabled />
                </div>
                <div className="hub-form-group">
                  <label>Pet Type</label>
                  <input value={form.petType} disabled />
                </div>
                <div className="hub-form-group">
                  <label>Breed</label>
                  <input value={form.breed} disabled />
                </div>
                <div className="hub-form-group">
                  <label>Owner Name</label>
                  <input value={form.ownerName} disabled />
                </div>
              </div>
            </div>

            <div className="hub-form-section">
              <h4>Schedule &amp; Service</h4>
              <div className="hub-form-grid">
                <div className="hub-form-group">
                  <label>Appointment Date *</label>
                  <DatePickerInput
                    selected={parseDateOnly(form.appointmentDate)}
                    onChange={(date) => setForm((prev) => ({ ...prev, appointmentDate: formatDateOnly(date) }))}
                    minDate={new Date()}
                    required
                  />
                </div>

                <div className="hub-form-group">
                  <label>Appointment Time</label>
                  <select name="appointmentTime" value={form.appointmentTime} onChange={handleInputChange}>
                    <option value="10:00">10:00 AM</option>
                    <option value="11:00">11:00 AM</option>
                    <option value="14:00">2:00 PM</option>
                    <option value="15:00">3:00 PM</option>
                    <option value="16:00">4:00 PM</option>
                    <option value="17:00">5:00 PM</option>
                  </select>
                </div>

                {form.bookingType === "hotel" && (
                  <>
                    <div className="hub-form-group">
                      <label>Room Type *</label>
                      <select name="roomType" value={form.roomType} onChange={handleInputChange} required>
                        <option value="">Select an available room...</option>
                        {hotelRooms.length > 0 ? (
                          hotelRooms.map((room) => (
                            <option key={room.id} value={room.type || room.room_type || room.name || `Room ${room.id}`}>
                              {room.type || room.room_type || room.name || `Room ${room.id}`} - ₱{room.daily_rate || 0}/day
                              {room.status && room.status !== "available" ? ` (${room.status})` : ""}
                            </option>
                          ))
                        ) : (
                          <>
                            <option value="Standard Room">Standard Room - ₱50/day</option>
                            <option value="Deluxe Suite">Deluxe Suite - ₱80/day</option>
                            <option value="Presidential Suite">Presidential Suite - ₱120/day</option>
                          </>
                        )}
                      </select>
                      {hotelRooms.length === 0 && (
                        <small style={{ color: "var(--color-warning, #d97706)", fontSize: "12px" }}>
                          Using default room options (hotel rooms data unavailable)
                        </small>
                      )}
                    </div>
                    <div className="hub-form-group">
                      <label>Duration</label>
                      <input value="Same-day stay (10:00 AM – 6:00 PM)" disabled />
                    </div>
                    <div className="hub-form-group">
                      <label>Service *</label>
                      <select name="service" value={form.service || "Pet Hotel Stay"} onChange={handleInputChange} required>
                        <option value="Pet Hotel Stay">Pet Hotel Stay</option>
                        <option value="Day Care">Day Care</option>
                        <option value="Pet Training">Pet Training</option>
                      </select>
                    </div>
                    <div className="hub-form-group full">
                      <label>Vaccination Card (Optional)</label>
                      <input
                        type="file"
                        name="vaccinationCard"
                        accept="image/*,.pdf"
                        onChange={(e) => setForm((prev) => ({ ...prev, vaccinationCard: e.target.files[0] }))}
                      />
                      <small style={{ color: "var(--color-muted, #6b7280)", fontSize: "12px" }}>
                        Upload a photo or PDF of the pet&apos;s vaccination records (optional)
                      </small>
                    </div>
                  </>
                )}

                {form.bookingType === "vet" && (
                  <>
                    <div className="hub-form-group">
                      <label>Service *</label>
                      <select name="service" value={form.service} onChange={handleInputChange} required>
                        <option value="">Select a service</option>
                        {vetServices.map((service) => (
                          <option key={service.id} value={service.id}>
                            {service.name} - {formatCurrency(service.price)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="hub-form-group full">
                      <label>Symptoms</label>
                      <textarea name="symptoms" value={form.symptoms} onChange={handleInputChange} placeholder="Describe symptoms or reason for visit..." />
                    </div>
                    <div className="hub-form-group full">
                      <label>Medical Notes</label>
                      <textarea name="medicalNotes" value={form.medicalNotes} onChange={handleInputChange} placeholder="Optional medical notes..." />
                    </div>
                  </>
                )}

                {form.bookingType === "grooming" && (
                  <div className="hub-form-group">
                    <label>Service *</label>
                    <select name="service" value={form.service} onChange={handleInputChange} required>
                      <option value="">Select a service</option>
                      {groomingServices.map((service) => (
                        <option key={service.id} value={service.id}>
                          {service.name} - {formatCurrency(service.price)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="hub-form-group full">
                  <label>Special Requests</label>
                  <textarea name="specialRequests" value={form.specialRequests} onChange={handleInputChange} placeholder="Any special requests or notes..." />
                </div>
              </div>
            </div>

            <div className="hub-form-section">
              <h4>Payment Information</h4>
              <div className="hub-payment-preview">
                <div><span>Estimated Amount</span><strong>{formatCurrency(calculatedAmount)}</strong></div>
                <div><span>Paid Amount</span><strong>{formatCurrency(form.paidAmount)}</strong></div>
                <div><span>Payment Status</span><strong>{getPaymentStatusFromAmount(calculatedAmount, form.paidAmount)}</strong></div>
              </div>
              <div className="hub-form-grid">
                <div className="hub-form-group">
                  <label>Payment Method *</label>
                  <select name="paymentMethod" value={form.paymentMethod} onChange={handleInputChange} required>
                    <option value="cash">Cash</option>
                    <option value="card">Credit Card</option>
                    <option value="gcash">GCash</option>
                    <option value="bank">Bank Transfer</option>
                  </select>
                </div>
                <div className="hub-form-group">
                  <label>Paid Amount</label>
                  <input
                    type="number"
                    name="paidAmount"
                    value={form.paidAmount}
                    onChange={handleInputChange}
                    placeholder="0.00"
                    min="0"
                    step="0.01"
                  />
                </div>
              </div>
            </div>

            <div className="hbk-foot">
              <button type="button" className="hbk-btn secondary" onClick={onClose} disabled={processing}>
                Cancel
              </button>
              <button type="submit" className="hbk-btn approve" disabled={processing}>
                {processing && <FontAwesomeIcon icon={faSpinner} spin />} Create Booking
              </button>
            </div>
          </form>
        </div>
      </div>

      <BookingReviewModal
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        onConfirm={confirmBooking}
        loading={processing}
        badge={`Walk-in · ${form.bookingType === "hotel" ? "Pet Hotel" : form.bookingType === "vet" ? "Veterinary" : "Grooming"}`}
        pet={form.petName ? {
          name: form.petName,
          species: form.petType,
          breed: form.breed,
        } : null}
        details={[
          { label: "Customer", value: form.ownerName },
          { label: "Service", value: form.bookingType === "hotel" ? (form.service || "Pet Hotel Stay") : (selectedService?.name || form.service) },
          { label: "Date", value: form.appointmentDate && new Date(`${form.appointmentDate}T00:00:00`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) },
          form.bookingType === "hotel"
            ? { label: "Duration", value: "Same-day stay (10:00 AM – 6:00 PM)" }
            : { label: "Time", value: form.appointmentTime },
          form.bookingType === "hotel" ? { label: "Room type", value: form.roomType } : null,
          { label: "Payment method", value: String(form.paymentMethod || "").toUpperCase() },
          Number(form.paidAmount) > 0 ? { label: "Paid amount", value: formatCurrency(form.paidAmount) } : null,
        ].filter(Boolean)}
        pricing={calculatedAmount > 0 ? {
          rows: [{
            label: form.bookingType === "hotel"
              ? `${form.roomType} — ${formatCurrency(roomRates[form.roomType] || calculatedAmount)}/day`
              : selectedService?.name || "Service",
            value: formatCurrency(calculatedAmount),
          }],
          total: formatCurrency(calculatedAmount),
        } : null}
        notes={buildNotes()}
        attachment={form.vaccinationCard ? {
          name: form.vaccinationCard.name,
          previewUrl: vaccinationPreview,
          isImage: form.vaccinationCard.type?.startsWith("image/"),
        } : null}
      />
    </div>
  );
};

export default NewWalkInBookingModal;
