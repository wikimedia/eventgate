'use strict';

const P     = require('bluebird');
const kafka = require('node-rdkafka');

/**
 * This file contains two kafka.Producer sublclasses: a 'GuaranteedProducer' and a 'HastyProducer'
 * The difference between the two is the use of the delivery-report callback.
 * GuaranteedProducer will wait for a produce request to be returned from the Kafka broker
 * (inclulding retries) before resolving its Promise.  HastyProducer will resolve the produce
 * Promise as soon as node-rdkafka accepts the produce request, and not wait for the Kafka brokers
 * to ACK the result.
 */

// Originally taken from
// https://github.com/wikimedia/change-propagation/blob/06178c20779c5ff213dcfdaca92fef0072e0d469/lib/kafka_factory.js


// rdkafka log messages come out like
// [thrd:main]:   Topic staging.test.event partition 0 Leader 1003
// Capture the thread name and the log message out of it.
const rdkafkaLogMessageRegex =  /^\[thrd:(.+?)\]:\s+(.*)$/;


/**
 * Maps syslog severity levels (from rdkafka) to appropriate
 * bunyan log levels.
 */
const syslogSeverityToBunyanMap = {
    0: 'fatal',
    1: 'fatal',
    2: 'fatal',
    3: 'error',
    4: 'warn',
    5: 'info',
    6: 'debug',
    7: 'trace'
};

/**
 * Registers node-rdkafka event.error and event.log events
 * to be logged appropriately by the provided bunyan logger.
 * Log events will not be logged unless event_cb: true is set
 * in kafka client config.
 * To use this well, you should also set kafka.conf.log_level (to get rdkafka to log things)
 * and/or kafka.conf.debug: broker,topic,msg (or whatever facilities you want).
 * @param {Object} kafkaClient node-rdkafka client, producer or consumer.
 * @param {Object} logger bunyan logger.
 */
function registerKafkaLogHandler(kafkaClient, logger) {
    logger.trace('Registering rdkafka log handler');

    // Log rdkafka errors at error level.
    kafkaClient.on('event.error', (error) => {
        logger.error({ error }, `Encountered rdkafka error event: ${error.message}`);
    });

    // Log rdkafka log messages at appropriate log level.
    kafkaClient.on('event.log', (rdkafkaLog) => {
        // Parse the thread name out of the message header.
        let thread = 'unknown';
        let message = rdkafkaLog.message;

        const match = rdkafkaLog.message.match(rdkafkaLogMessageRegex);
        if (match && match.length === 3) {
            // Get the first matched group as the rdkafka thread name.
            thread = match[1];
            // The second match group will contain the log message.
            message = match[2];
        }
        // Log at the appropriate bunyan severity level.
        const bunyanLogLevel = syslogSeverityToBunyanMap[rdkafkaLog.severity];
        logger[bunyanLogLevel](
            { rdkafka_facility: rdkafkaLog.fac, rdkafka_thread: thread },
            message
        );
    });
}

/**
 * Uses the node-rdkafka delivery-report callback to resolve the produce call Promise
 * based on the Kafka broker delivery status.
 */
class GuaranteedProducer extends kafka.Producer {
    /**
     * @inheritdoc
     */
    constructor(conf, topicConf) {
        super(conf, topicConf);

        this.on('delivery-report', (err, report) => {
            const reporter = report.opaque;
            if (err) {
                return reporter.rejecter(err);
            }
            return reporter.resolver(report);
        });

        this.on('ready', () => {
            this._pollInterval = setInterval(() => this.poll(), 10);
        });
    }

    /**
     * @inheritdoc
     */
    disconnect(cb) {
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
        }
        return super.disconnect(cb);
    }

    /**
     * @inheritdoc
     */
    produce(topic, partition, message, key) {
        return new P((resolve, reject) => {
            const report = {
                resolver: resolve,
                rejecter: reject
            };
            try {
                const result = super.produce(topic, partition, message, key, undefined, report);
                if (result !== true) {
                    process.nextTick(() => {
                        reject(result);
                    });
                }
            } catch (e) {
                process.nextTick(() => {
                    reject(e);
                });
            } finally {
                this.poll();
            }
        });
    }
}

/**
 * Returns a Promise of a connected GuaranteedProducer ready for producing.
 * @param {Object} config  Kafka config
 * @param {Object} topicConfig Kafka topic config
 * @param {Object} logger bunyan logger.  If given, will be used for rdkafka event.log callback
 * @return {Promise<Object>}
 */
GuaranteedProducer.factory = (config = {}, topicConfig = {}, logger) => {
    const defaultConfig = {
        'metadata.broker.list': 'localhost:9092',
        'dr_cb': true
    };

    const defaultTopicConfig = {};

    config = Object.assign(defaultConfig, config);
    topicConfig = Object.assign(defaultTopicConfig, topicConfig);

    const producerPromise = new P((resolve, reject) => {
        const producer = new GuaranteedProducer(defaultConfig, topicConfig);
        producer.once('event.error', reject);

        // If given a bunyan logger, use it to log rdkafka event.log events.
        if (logger) {
            registerKafkaLogHandler(producer, logger.child({ 'producer_type': 'guaranteed' }));
        }

        producer.connect(undefined, (err) => {
            if (err) {
                return reject(err);
            }
            return resolve(producer);
        });
    });

    return producerPromise;
};


/**
 * Resolves a produce call Promise as soon as node-rdkafka accepts the produce request.
 * This producer will not wait for a delivery report for the message.
 */
class HastyProducer extends kafka.Producer {
    /**
     * @inheritdoc
     */
    produce(topic, partition, message, key) {
        return new P((resolve, reject) => {
            try {
                const result = super.produce(topic, partition, message, key);
                if (result !== true) {
                    return reject(result);
                }
                return resolve(result);
            } catch (e) {
                return reject(e);
            } finally {
                this.poll();
            }
        });
    }
}

/**
 * Returns a Promise of a connected HastyProducer ready for producing.
 * A hasty producer does not use a delivery callback, and will not wait
 * for  delivery confirmation before resolving a produce promise.
 * @param {Object} config  Kafka config
 * @param {Object} topicConfig Kafka topic config.
 * @param {Object} logger bunyan logger.  If given, will be used for rdkafka event.log callback
 * @return {Promise<Object>}
 */
HastyProducer.factory = (config = {}, topicConfig = {}, logger = null) => {
    const defaultConfig = {
        'metadata.broker.list': 'localhost:9092',
        'dr_cb': false,
    };

    const defaultTopicConfig = {};

    config = Object.assign(defaultConfig, config);
    topicConfig = Object.assign(defaultTopicConfig, topicConfig);

    const producerPromise = new P((resolve, reject) => {
        const producer = new HastyProducer(defaultConfig, topicConfig);
        producer.once('event.error', reject);

        // If given a bunyan logger, use it to log rdkafka event.log events.
        if (logger) {
            registerKafkaLogHandler(producer, logger.child({ 'producer_type': 'hasty' }));
        }

        producer.connect(undefined, (err) => {
            if (err) {
                return reject(err);
            }
            return resolve(producer);
        });
    });

    return producerPromise;
};

module.exports = {
    GuaranteedProducer,
    HastyProducer
};
