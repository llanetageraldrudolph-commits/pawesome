import React, { useState, useEffect, useCallback, useRef } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faPlus,
  faTimes,
  faMoneyBillWave,
  faExclamationTriangle,
  faSpinner,
  faReceipt,
  faBoxOpen,
  faStethoscope
} from "@fortawesome/free-solid-svg-icons";
import toast from "react-hot-toast";
import { apiRequest } from "../../api/client";
import "./ServiceBillingPanel.css";

const toMoney = (value) => Number(value || 0).toFixed(2);

const ServiceBillingPanel = ({ serviceType, serviceId, petId, onBillingUpdate }) => {
  const [billingItems, setBillingItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formData, setFormData] = useState({
    item_type: "manual_charge",
    description: "",
    quantity: 1,
    unit_price: 0,
    inventory_item_id: "",
    notes: ""
  });
  const [billingSummary, setBillingSummary] = useState({
    total_bill: 0,
    total_paid: 0,
    balance_due: 0,
    has_unpaid_balance: false
  });
  const [completionStatus, setCompletionStatus] = useState({
    can_complete: true,
    balance_due: 0,
    message: ""
  });

  const onBillingUpdateRef = useRef(onBillingUpdate);
  useEffect(() => {
    onBillingUpdateRef.current = onBillingUpdate;
  }, [onBillingUpdate]);

  // Common service icons
  const getServiceIcon = (itemType) => {
    const icons = {
      "base_service": faStethoscope,
      "inventory_usage": faBoxOpen,
      "manual_charge": faMoneyBillWave,
      "discount": faReceipt
    };
    return icons[itemType] || faPlus;
  };

  const fetchBillingData = useCallback(async () => {
    try {
      setLoading(true);
      const response = await apiRequest(`/billing/${serviceType}/${serviceId}/summary`);
      if (response.success) {
        setBillingItems(response.billing.items || []);
        setBillingSummary(response.billing);
        setCompletionStatus(response.completion_status);
        onBillingUpdateRef.current?.(response.billing, response.completion_status);
      }
    } catch (error) {
      console.error("Failed to fetch billing data:", error);
      toast.error("Failed to load billing information");
    } finally {
      setLoading(false);
    }
  }, [serviceType, serviceId]);

  // Fetch billing data
  useEffect(() => {
    if (serviceType && serviceId) {
      fetchBillingData();
    }
  }, [serviceType, serviceId, fetchBillingData]);

  const handleAddBillingItem = async (e) => {
    e.preventDefault();
    try {
      setLoading(true);
      
      const payload = {
        service_type: serviceType,
        service_id: serviceId,
        pet_id: petId,
        ...formData,
        total_price: formData.quantity * formData.unit_price
      };

      const response = await apiRequest("/billing/items", {
        method: "POST",
        body: JSON.stringify(payload)
      });

      if (response.success) {
        toast.success("Billing item added successfully");
        setShowAddForm(false);
        resetForm();
        fetchBillingData();
      } else {
        toast.error(response.message || "Failed to add billing item");
      }
    } catch (error) {
      console.error("Failed to add billing item:", error);
      toast.error(error.message || "Failed to add billing item");
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setFormData({
      item_type: "manual_charge",
      description: "",
      quantity: 1,
      unit_price: 0,
      inventory_item_id: "",
      notes: ""
    });
  };

  const getCommonServices = () => {
    if (serviceType === "veterinary") {
      return [
        { name: "Anti-rabies Vaccination", price: 800 },
        { name: "Deworming", price: 350 },
        { name: "Laboratory Test", price: 1200 },
        { name: "X-Ray", price: 1500 },
        { name: "Ultrasound", price: 2000 },
        { name: "Blood Test", price: 800 },
        { name: "Urine Test", price: 500 }
      ];
    } else if (serviceType === "grooming") {
      return [
        { name: "Flea Treatment", price: 250 },
        { name: "Medicated Shampoo", price: 150 },
        { name: "Nail Grinding", price: 200 },
        { name: "De-matting", price: 300 },
        { name: "Teeth Cleaning", price: 350 },
        { name: "Ear Cleaning", price: 150 }
      ];
    } else if (serviceType === "boarding") {
      return [
        { name: "Special Food", price: 150 },
        { name: "Medication", price: 100 },
        { name: "Extended Stay", price: 700 },
        { name: "Special Care", price: 200 },
        { name: "Cleaning Fee", price: 100 },
        { name: "Playtime", price: 150 }
      ];
    }
    return [];
  };

  const handleQuickServiceSelect = (service) => {
    setFormData(prev => ({
      ...prev,
      description: service.name,
      unit_price: service.price,
      item_type: "add_on_service",
      inventory_item_id: ""
    }));
  };

  if (loading && billingItems.length === 0) {
    return (
      <div className="billing-panel loading">
        <FontAwesomeIcon icon={faSpinner} spin />
        <span>Loading billing information...</span>
      </div>
    );
  }

  return (
    <div className="service-billing-panel">
      <div className="billing-header">
        <h3>
          <FontAwesomeIcon icon={faReceipt} />
          Service Billing
        </h3>
        <div className="billing-summary">
          <div className="summary-item">
            <span className="label">Total Bill:</span>
            <span className="amount total">₱{toMoney(billingSummary.total_bill)}</span>
          </div>
          <div className="summary-item">
            <span className="label">Amount Paid:</span>
            <span className="amount paid">₱{toMoney(billingSummary.total_paid)}</span>
          </div>
          <div className="summary-item">
            <span className="label">Balance Due:</span>
            <span className={`amount balance ${billingSummary.balance_due > 0 ? 'unpaid' : 'paid'}`}>
              ₱{toMoney(billingSummary.balance_due)}
            </span>
          </div>
        </div>
      </div>

      {!completionStatus.can_complete && (
        <div className="completion-warning">
          <FontAwesomeIcon icon={faExclamationTriangle} />
          <span>{completionStatus.message}</span>
        </div>
      )}

      <div className="billing-items">
        <div className="items-header">
          <h4>Itemized Charges</h4>
          <button
            className="add-item-btn"
            onClick={() => setShowAddForm(!showAddForm)}
          >
            <FontAwesomeIcon icon={faPlus} />
            Add Charge
          </button>
        </div>

        {billingItems.length === 0 ? (
          <div className="no-items">
            <FontAwesomeIcon icon={faReceipt} />
            <p>No billing items yet</p>
          </div>
        ) : (
          <div className="items-list">
            {billingItems.map((item, index) => (
              <div key={item.id || index} className="billing-item">
                <div className="item-icon">
                  <FontAwesomeIcon icon={getServiceIcon(item.item_type)} />
                </div>
                <div className="item-details">
                  <div className="item-description">{item.description}</div>
                  <div className="item-meta">
                    <span className="quantity">{item.quantity} {item.unit}</span>
                    <span className="unit-price">₱{toMoney(item.unit_price)} each</span>
                    {item.inventory_item && (
                      <span className="inventory-tag">Inventory</span>
                    )}
                  </div>
                  {item.notes && (
                    <div className="item-notes">{item.notes}</div>
                  )}
                </div>
                <div className="item-total">
                  ₱{toMoney(item.total_price)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showAddForm && (
        <div className="add-billing-form">
          <div className="form-header">
            <h4>Add Billing Item</h4>
            <button
              className="close-btn"
              onClick={() => {
                setShowAddForm(false);
                resetForm();
              }}
            >
              <FontAwesomeIcon icon={faTimes} />
            </button>
          </div>

          <form onSubmit={handleAddBillingItem}>
            <div className="form-row">
              <div className="form-group">
                <label>Item Type</label>
                <select
                  value={formData.item_type}
                  onChange={(e) => setFormData(prev => ({ ...prev, item_type: e.target.value }))}
                >
                  <option value="manual_charge">Manual Charge</option>
                  <option value="discount">Discount</option>
                </select>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group flex-1">
                <label>Description</label>
                <input
                  type="text"
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Enter description"
                  required
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Quantity</label>
                <input
                  type="number"
                  min="1"
                  value={formData.quantity}
                  onChange={(e) => setFormData(prev => ({ ...prev, quantity: parseInt(e.target.value) || 1 }))}
                  required
                />
              </div>
              <div className="form-group">
                <label>Unit Price</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={formData.unit_price}
                  onChange={(e) => setFormData(prev => ({ ...prev, unit_price: parseFloat(e.target.value) || 0 }))}
                  required
                />
              </div>
              <div className="form-group">
                <label>Total</label>
                <div className="total-display">
                  ₱{(formData.quantity * formData.unit_price).toFixed(2)}
                </div>
              </div>
            </div>

            <div className="form-group">
              <label>Notes (optional)</label>
              <textarea
                value={formData.notes}
                onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                placeholder="Additional notes..."
                rows="2"
              />
            </div>

            <div className="form-actions">
              <button type="button" onClick={() => { setShowAddForm(false); resetForm(); }}>
                Cancel
              </button>
              <button type="submit" disabled={loading}>
                {loading ? <FontAwesomeIcon icon={faSpinner} spin /> : <FontAwesomeIcon icon={faPlus} />}
                Add Item
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export default ServiceBillingPanel;
