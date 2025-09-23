(function execute(inputs, outputs) {
    /**
     * ServiceNow Flow Action Script - Chempax Purchase Order Integration
     * 
     * This script prepares and sends purchase order data to the Chempax system.
     * It handles authentication, data transformation, and payload generation.
     * 
     * @param {Object} inputs - Flow inputs containing purchase_order and identity
     * @param {Object} outputs - Flow outputs for token, datacorponum, and payload
     */

    // === Configuration & Constants ===
    const CONFIG = {
        DEFAULT_WAREHOUSE: 'DIRECT',
        ERROR_WAREHOUSE: 'ERROR',
        COST_RECORD_LIMIT: 150,
        DEFAULT_SHIP_FROM_SEQUENCE: 1,
        CURRENCY_SYMBOL: '$',
        COST_SOURCE: 'costs',
        COST_TABLE: 'sn_shop_cost_allocation',
        BASE_COST_CATEGORY: 'RMC',
        BASE_COST_TYPE: 'Additional',
        BASE_COST_SEQUENCE: 0
    };

    // === Initialize utilities and services ===
    const utils = new global.TPP_GlobalUtilities();
    const flowUtils = new x_supr2_supreme_ca.TPP_ComplexFlowUtils();
    
    // === Main execution flow ===
    try {
        // Step 1: Authenticate
        const authToken = authenticate(inputs.identity);
        outputs.token = 'Bearer ' + authToken;
        
        // Step 2: Get correlation ID
        outputs.datacorponum = getCorrelationId(inputs.purchase_order);
        
        // Step 3: Build and output payload
        outputs.payload = JSON.stringify(buildPayload(inputs.purchase_order, outputs.datacorponum));
        
    } catch (error) {
        gs.error('TPP Chempax Integration Error: ' + error.message);
        throw error;
    }

    // === Authentication Function ===
    function authenticate(identity) {
        const token = utils.getOauthToken(identity);
        if (!token) {
            throw new Error('Unable to retrieve Authentication token from Chempax. Check logs.');
        }
        return token;
    }

    // === Correlation ID Function ===
    function getCorrelationId(purchaseOrder) {
        return flowUtils.getCorrelationID(
            purchaseOrder.sys_class_name, 
            purchaseOrder.sys_id, 
            'chempax'
        );
    }

    // === Main Payload Builder ===
    function buildPayload(purchaseOrder, correlationNum) {
        const payload = {
            // Basic PO Information
            SupplierNumber: getFieldValue(purchaseOrder.supplier.erp_company_code),
            PODate: formatDate(purchaseOrder.created),
            
            // Optional dates
            ...(purchaseOrder.x_supr2_supreme_ca_ship_date && {
                ShipDate: formatDate(purchaseOrder.x_supr2_supreme_ca_ship_date)
            }),
            ...(purchaseOrder.expected_delivery && {
                DueDate: formatDate(purchaseOrder.expected_delivery)
            }),
            
            // Warehouse determination
            Warehouse: determineWarehouse(purchaseOrder),
            
            // Additional metadata
            ApprovedBy: getFieldValue(purchaseOrder.x_supr2_supreme_ca_assigned_to.first_name),
            ShipVia: getFieldValue(purchaseOrder.shipping_method.name),
            ShipFromSequence: Number(purchaseOrder.x_supr2_supreme_ca_ship_from_location.external_unique_id) || CONFIG.DEFAULT_SHIP_FROM_SEQUENCE,
            
            // Costs and line items
            Costs: buildPOCosts(purchaseOrder),
            Items: buildLineItems(purchaseOrder, correlationNum)
        };
        
        return payload;
    }

    // === Warehouse Determination ===
    function determineWarehouse(purchaseOrder) {
        if (purchaseOrder.u_direct_ship === 'false') {
            const warehouse = getWarehouseFromAsset(purchaseOrder);
            return (warehouse === CONFIG.ERROR_WAREHOUSE) ? CONFIG.DEFAULT_WAREHOUSE : warehouse;
        }
        return CONFIG.DEFAULT_WAREHOUSE;
    }

    // === Get Warehouse from Asset ===
    function getWarehouseFromAsset(purchaseOrder) {
        const lineRec = new GlideRecord('sn_shop_purchase_order_line');
        lineRec.addQuery('purchase_order', purchaseOrder.sys_id.toString());
        lineRec.setLimit(1);
        lineRec.query();
        
        if (lineRec.next()) {
            const asset = new GlideRecord('x_supr2_supreme_ca_lot_asset');
            asset.addQuery('purchase_order_line', lineRec.sys_id.toString());
            asset.setLimit(1);
            asset.query();
            
            if (asset.next()) {
                return flowUtils.getWarehouse(asset.sys_id.toString()) || CONFIG.DEFAULT_WAREHOUSE;
            }
        }
        return CONFIG.DEFAULT_WAREHOUSE;
    }

    // === Build Line Items ===
    function buildLineItems(purchaseOrder, correlationNum) {
        const items = [];
        const poLineIds = flowUtils.getMatchingRecords(
            'sn_shop_purchase_order_line', 
            'purchase_order=' + purchaseOrder.sys_id.toString()
        ).split(',');
        
        poLineIds.forEach(lineId => {
            const lineItem = buildLineItem(lineId, purchaseOrder, correlationNum);
            if (lineItem) {
                items.push(lineItem);
            }
        });
        
        return items;
    }

    // === Build Single Line Item ===
    function buildLineItem(lineId, purchaseOrder, correlationNum) {
        const lineRec = new GlideRecord('sn_shop_purchase_order_line');
        if (!lineRec.get(lineId)) {
            return null;
        }
        
        const spidData = flowUtils.getSPIDfromPOL(lineId);
        const spid = spidData.spid || 0;
        
        const supRec = new GlideRecord('sn_shop_supplier_product');
        supRec.get(spidData.record);
        
        return {
            SPID: spid,
            ProductNumber: getFieldValue(supRec.sku),
            Measure: Number(supRec.product_model.x_supr2_supreme_ca_measure.toString()),
            UnitOfMeasure: lineRec.getDisplayValue('uom').toString().charAt(0),
            UnitOfPackaging: getFieldValue(supRec.product_model.x_supr2_supreme_ca_packaging),
            Quantity: Number(lineRec.purchased_quantity),
            QuantityUM: "Packages",
            Costs: buildLineItemCosts(lineId, purchaseOrder, spid, correlationNum)
        };
    }

    // === Build PO-level Costs ===
    function buildPOCosts(purchaseOrder) {
        const costs = [];
        let costSequence = 0;
        
        const recCosts = new GlideRecord('sn_shop_cost_allocation');
        recCosts.addQuery('x_supr2_supreme_ca_purchase_order', purchaseOrder.sys_id.toString());
        recCosts.addNullQuery('order_line');
        recCosts.setLimit(CONFIG.COST_RECORD_LIMIT);
        recCosts.query();
        
        while (recCosts.next()) {
            const sequence = getOrCreateCostSequence(recCosts, costSequence);
            
            costs.push({
                Sequence: sequence,
                CostCategory: recCosts.getDisplayValue('x_supr2_supreme_ca_category'),
                Percentage: parseFloatOrNull(recCosts.allocation_percentage),
                Amount: parseCurrencyAmount(recCosts.getDisplayValue('allocation_amount')),
                ApportionBy: recCosts.getValue('x_supr2_supreme_ca_apportion_by'),
                UnitOfCurrency: null,
                ExchangeRate: null
            });
            
            costSequence++;
        }
        
        return costs;
    }

    // === Build Line Item Costs ===
    function buildLineItemCosts(lineId, purchaseOrder, spid, correlationNum) {
        const costs = [];
        
        // Add base cost (sequence 0)
        costs.push(buildBaseCost(lineId, spid, correlationNum));
        
        // Add additional costs
        let costSequence = 1;
        const recCosts = new GlideRecord('sn_shop_cost_allocation');
        recCosts.addQuery('order_line', lineId);
        recCosts.addQuery('x_supr2_supreme_ca_purchase_order', purchaseOrder.sys_id.toString());
        recCosts.setLimit(CONFIG.COST_RECORD_LIMIT);
        recCosts.query();
        
        while (recCosts.next()) {
            const sequence = getOrCreateCostSequence(recCosts, costSequence);
            const amount = parseCurrencyAmount(recCosts.getDisplayValue('allocation_amount'));
            
            costs.push({
                Sequence: sequence,
                CostCategory: recCosts.getDisplayValue('x_supr2_supreme_ca_category'),
                PurchaseOrderNumber: correlationNum,
                SPID: spid,
                Cost: amount,
                TotalCost: amount,
                CostType: CONFIG.BASE_COST_TYPE
            });
            
            costSequence++;
        }
        
        return costs;
    }

    // === Build Base Cost (Sequence 0) ===
    function buildBaseCost(lineId, spid, correlationNum) {
        const lineRec = new GlideRecord('sn_shop_purchase_order_line');
        lineRec.get(lineId);
        
        return {
            PurchaseOrderNumber: correlationNum,
            SPID: spid,
            Sequence: CONFIG.BASE_COST_SEQUENCE,
            CostCategory: CONFIG.BASE_COST_CATEGORY,
            CostType: CONFIG.BASE_COST_TYPE,
            Cost: parseCurrencyAmount(lineRec.getDisplayValue('unit_price')),
            TotalCost: parseCurrencyAmount(lineRec.getDisplayValue('total_line_amount'))
        };
    }

    // === Cost Sequence Management ===
    function getOrCreateCostSequence(costRecord, defaultSequence) {
        const lookup = new GlideRecord('x_supr2_supreme_ca_correlation_lookup');
        lookup.addEncodedQuery('source=' + CONFIG.COST_SOURCE + '^active=true^record=' + costRecord.sys_id.toString());
        lookup.setLimit(1);
        lookup.query();
        
        if (lookup.next()) {
            return Number(lookup.correlation_id) || defaultSequence;
        }
        
        // Create new lookup record
        createLookupRecord(costRecord.sys_id.toString(), defaultSequence);
        return defaultSequence;
    }

    // === Create Lookup Record ===
    function createLookupRecord(recordId, sequence) {
        const lookup = new GlideRecord('x_supr2_supreme_ca_correlation_lookup');
        lookup.initialize();
        lookup.source = CONFIG.COST_SOURCE;
        lookup.record = recordId;
        lookup.correlation_id = sequence.toString();
        lookup.table = CONFIG.COST_TABLE;
        lookup.active = true;
        lookup.insert();
    }

    // === Utility Functions ===
    
    /**
     * Format GlideDateTime to ISO date format (YYYY-MM-DD)
     */
    function formatDate(dateValue) {
        if (!dateValue) return null;
        
        const glideDate = new GlideDateTime(dateValue);
        return glideDate.getDate().getByFormat('yyyy-MM-dd');
    }
    
    /**
     * Parse currency amount from display value
     */
    function parseCurrencyAmount(displayValue) {
        if (!displayValue) return null;
        
        // Remove currency symbol and commas, then parse
        const cleanValue = displayValue
            .substring(1)  // Remove currency symbol
            .replace(/,/g, '');  // Remove commas
            
        return parseFloat(cleanValue) || null;
    }
    
    /**
     * Parse float value or return null
     */
    function parseFloatOrNull(value) {
        const parsed = parseFloat(value);
        return isNaN(parsed) ? null : parsed;
    }
    
    /**
     * Get field value as string
     */
    function getFieldValue(field) {
        return field ? field.toString() : '';
    }

})(inputs, outputs);